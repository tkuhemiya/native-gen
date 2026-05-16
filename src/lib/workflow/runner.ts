import {
  assertConnectedDAG,
  GraphError,
  topologicalOrderPreferLeft,
} from "./graph";
import {
  type GenerationPlan,
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
} from "./generation-plan";
import type { WorkflowEdge, WorkflowNode } from "./schema";
import { logWorkflow } from "./workflow-debug-log";

export type RuntimeOutputs = Record<
  string,
  | { type: "text"; value: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string }
  | {
      type: "generation";
      text?: string;
      imageUrl?: string;
      videoUrl?: string;
    }
  | {
      type: "mediaInput";
      text: string;
      imageUrls: string[];
      videoUrls: string[];
    }
  | {
      type: "bundle";
      files: { path: string; blob: Blob }[];
      publish?: {
        platform: "facebook" | "instagram";
        imageUrls: string[];
        caption: string;
      };
      publishYoutube?: {
        videoUrl: string;
        title: string;
        description: string;
      };
    }
>;

export type RunProgress = {
  phase: "idle" | "running" | "done" | "error";
  message?: string;
  step?: { index: number; total: number; nodeId: string };
};

export type NodeRunComplete = {
  nodeId: string;
  index: number;
  total: number;
  label: string;
  output: RuntimeOutputs[string];
  /** True when output was copied from {@link runWorkflowDAG} `reuseOutputs`. */
  reused?: boolean;
};

function runLabel(node: WorkflowNode): string {
  return node.data.label.trim() || node.data.kind;
}

function isTextTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && (edge.targetHandle == null || edge.targetHandle === "text");
}

function isImageTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && (edge.targetHandle == null || edge.targetHandle === "image");
}

function mediaInputTextFromEdge(edge: WorkflowEdge): boolean {
  const sh = edge.sourceHandle;
  return sh == null || sh === "text";
}

function mediaInputImagesFromEdge(edge: WorkflowEdge): boolean {
  const sh = edge.sourceHandle;
  return sh == null || sh === "image";
}

function mediaInputVideoFromEdge(edge: WorkflowEdge): boolean {
  const sh = edge.sourceHandle;
  return sh == null || sh === "video";
}

function collectUpstreamText(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string {
  const incoming = incomingByTarget.get(nodeId) ?? [];
  const parts: string[] = [];
  for (const edge of incoming) {
    if (!isTextTargetEdge(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    if (upstream.type === "generation") {
      if (edge.sourceHandle !== "text") continue;
      const t = upstream.text?.trim();
      if (t) parts.push(t);
      continue;
    }
    if (upstream.type === "text") {
      if (edge.sourceHandle === "image" || edge.sourceHandle === "video") continue;
      parts.push(upstream.value);
    }
    if (
      upstream.type === "mediaInput" &&
      upstream.text.trim() &&
      mediaInputTextFromEdge(edge)
    ) {
      parts.push(upstream.text);
    }
  }
  return parts.join("\n").trim();
}

function isVideoTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && edge.targetHandle === "video";
}

function collectUpstreamImageUrls(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string[] {
  const incoming = incomingByTarget.get(nodeId) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const edge of incoming) {
    if (!isImageTargetEdge(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    if (upstream.type === "generation") {
      const u = upstream.imageUrl;
      if (u && edge.sourceHandle === "image") {
        if (!seen.has(u)) {
          urls.push(u);
          seen.add(u);
        }
      }
      continue;
    }
    if (upstream.type === "image" && upstream.url) {
      if (edge.sourceHandle === "text" || edge.sourceHandle === "video") continue;
      if (!seen.has(upstream.url)) {
        urls.push(upstream.url);
        seen.add(upstream.url);
      }
    }
    if (upstream.type === "mediaInput" && mediaInputImagesFromEdge(edge)) {
      for (const u of upstream.imageUrls) {
        if (u && !seen.has(u)) {
          urls.push(u);
          seen.add(u);
        }
      }
    }
  }
  return urls;
}

function collectUpstreamVideoUrl(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string | undefined {
  const incoming = incomingByTarget.get(nodeId) ?? [];
  for (const edge of incoming) {
    if (!isVideoTargetEdge(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    if (upstream.type === "generation") {
      const u = upstream.videoUrl;
      if (u && edge.sourceHandle === "video") return u;
      continue;
    }
    if (upstream.type === "video") {
      if (edge.sourceHandle === "text" || edge.sourceHandle === "image") continue;
      return upstream.url;
    }
    if (
      upstream.type === "mediaInput" &&
      upstream.videoUrls[0] &&
      mediaInputVideoFromEdge(edge)
    ) {
      return upstream.videoUrls[0];
    }
  }
  return undefined;
}

/** Parse JSON bodies from `/api/fal/generation` (and raw fal-shaped errors). */
function extractFalProxyErrorMessage(
  body: Record<string, unknown>,
  httpStatus: number,
  rawText: string,
): string {
  const errStr = body.error;
  if (typeof errStr === "string" && errStr.trim()) return errStr.trim();

  const detail = body.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail.map((item: unknown) => {
      if (!item || typeof item !== "object") return "";
      const row = item as { msg?: unknown; loc?: unknown };
      const loc = Array.isArray(row.loc)
        ? row.loc.map(String).join(".")
        : String(row.loc ?? "");
      const m =
        typeof row.msg === "string"
          ? row.msg
          : row.msg != null
            ? JSON.stringify(row.msg)
            : "";
      return [loc, m].filter(Boolean).join(": ");
    });
    const joined = parts.filter(Boolean).join("; ").trim();
    if (joined) return joined.slice(0, 6000);
  }
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const o = detail as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) {
      return o.message.trim();
    }
    if (typeof o.msg === "string" && o.msg.trim()) return o.msg.trim();
  }

  const msg = body.message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();

  const trimmed = rawText.trim();
  if (trimmed.length > 0 && trimmed.length <= 16_000) {
    return trimmed.slice(0, 6000);
  }

  return `Generation failed (${httpStatus})`;
}

function generationCacheSatisfiesPlan(
  plan: GenerationPlan,
  cached: Extract<RuntimeOutputs[string], { type: "generation" }>,
): boolean {
  if (plan.needPassthroughText && !cached.text?.trim()) return false;
  if (plan.needCaption && !cached.text?.trim()) return false;
  if (plan.needTextToImage && !cached.imageUrl) return false;
  if (plan.needTextToVideo && !cached.videoUrl) return false;
  if (plan.needImageToVideo && !cached.videoUrl) return false;
  if (plan.needVideoToVideo && !cached.videoUrl) return false;
  return true;
}

export async function runWorkflowDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: {
    onProgress?: (p: RunProgress) => void;
    /** Fires after each node’s output is ready (same order as execution). */
    onNodeComplete?: (e: NodeRunComplete) => void;
    /** Outputs from an earlier run; generation blocks reuse when still valid for current wiring. */
    reuseOutputs?: RuntimeOutputs;
  } = {},
): Promise<RuntimeOutputs> {
  if (nodes.length === 0) {
    throw new GraphError("Add at least one node before running");
  }

  const { onProgress, onNodeComplete, reuseOutputs: reuseOutputsRaw } = options;
  const reuseOutputs =
    reuseOutputsRaw && Object.keys(reuseOutputsRaw).length > 0
      ? reuseOutputsRaw
      : undefined;

  logWorkflow("info", "runner", "Workflow DAG run started", {
    nodes: nodes.length,
    edges: edges.length,
    reuseCandidates: reuseOutputs ? Object.keys(reuseOutputs).length : 0,
  });

  assertConnectedDAG(nodes, edges);
  const order = topologicalOrderPreferLeft(nodes, edges);
  const totalSteps = order.length;
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = incomingByTarget.get(e.target) ?? [];
    list.push(e);
    incomingByTarget.set(e.target, list);
  }

  const outputs: RuntimeOutputs = {};

  onProgress?.({ phase: "running", message: "Executing workflow…" });

  for (let step = 0; step < order.length; step++) {
    const id = order[step]!;
    const node = nodesById.get(id)!;
    const data = node.data;
    const label = runLabel(node);
    onProgress?.({
      phase: "running",
      message: `${step + 1}/${totalSteps} · ${label}`,
      step: { index: step + 1, total: totalSteps, nodeId: id },
    });

    logWorkflow("debug", "runner/node", "Visit node", {
      step: step + 1,
      total: totalSteps,
      nodeId: id,
      kind: data.kind,
      label,
    });

    switch (data.kind) {
      case "mediaInput":
        outputs[id] = {
          type: "mediaInput",
          text: data.value,
          imageUrls: data.images.map((a) => a.dataUrl),
          videoUrls: data.videos.map((a) => a.dataUrl),
        };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      case "generationBlock": {
        const inL = incomingMediaLanes(id, incomingByTarget);
        const outL = outgoingMediaLanes(id, edges);
        const plan = planGeneration(inL, outL);

        if (reuseOutputs) {
          const cached = reuseOutputs[id];
          if (
            cached?.type === "generation" &&
            generationCacheSatisfiesPlan(plan, cached)
          ) {
            outputs[id] = cached;
            logWorkflow("info", "runner/node", "Skipped generation (reused prior output)", {
              nodeId: id,
              label,
            });
            onNodeComplete?.({
              nodeId: id,
              index: step + 1,
              total: totalSteps,
              label,
              output: cached,
              reused: true,
            });
            break;
          }
        }

        const promptNotes = collectUpstreamText(id, incomingByTarget, outputs).trim();
        const promptBody =
          promptNotes +
          (data.suffix.trim()
            ? `${promptNotes ? "\n" : ""}${data.suffix.trim()}`
            : "");
        const diffusionPrompt =
          promptBody.trim() ||
          data.suffix.trim() ||
          "Subtle cinematic motion, sharp detail, advertising polish";

        const wanPrompt =
          promptBody.trim() !== "" ? promptBody.trim().slice(0, 5000) : undefined;

        async function postGeneration(body: Record<string, unknown>) {
          const intent =
            typeof body.intent === "string" ? body.intent : "unknown";
          logWorkflow("info", "runner/fal", "Calling /api/fal/generation", {
            intent,
            promptChars:
              typeof body.prompt === "string" ? body.prompt.length : undefined,
            durationSec: body.durationSec,
            duration: body.duration,
            resolution: body.resolution,
          });
          const res = await fetch("/api/fal/generation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const rawText = await res.text();
          let parsedBody: Record<string, unknown> = {};
          try {
            const p = JSON.parse(rawText) as unknown;
            if (p && typeof p === "object" && !Array.isArray(p)) {
              parsedBody = p as Record<string, unknown>;
            }
          } catch {
            /* non-JSON error page */
          }

          if (!res.ok) {
            const msg = extractFalProxyErrorMessage(
              parsedBody,
              res.status,
              rawText,
            );
            logWorkflow("error", "runner/fal", "Generation HTTP error", {
              intent,
              httpStatus: res.status,
              message: msg.slice(0, 4000),
              rawPreview: rawText.slice(0, 2000),
              parsedKeys:
                Object.keys(parsedBody).length > 0
                  ? Object.keys(parsedBody).join(",")
                  : "(none)",
            });
            throw new GraphError(msg);
          }

          return parsedBody as Record<string, unknown>;
        }

        let textOut: string | undefined;
        let imageUrlOut: string | undefined;
        let videoUrlOut: string | undefined;

        if (plan.needPassthroughText) {
          if (!promptNotes) {
            throw new GraphError("Text output needs upstream copy wired to the text pin");
          }
          textOut = promptNotes;
        }

        if (plan.needCaption) {
          const imgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
          const imgUrl = imgs[0];
          if (!imgUrl) {
            throw new GraphError("Caption path needs an upstream image URL on the image pin");
          }
          const cap = await postGeneration({
            intent: "image-to-text",
            imageUrl: imgUrl,
          });
          const caption =
            typeof cap.text === "string" ? cap.text.trim() : "";
          if (!caption) throw new GraphError("Caption model returned empty text");
          textOut = [caption, promptNotes].filter(Boolean).join("\n\n");
        }

        if (plan.needTextToImage) {
          const body = await postGeneration({
            intent: "text-to-image",
            prompt: diffusionPrompt.slice(0, 4000),
            imageSize: data.imageSize,
            numInferenceSteps: data.numInferenceSteps,
          });
          const url =
            typeof (body.image as { url?: string } | undefined)?.url === "string"
              ? (body.image as { url: string }).url
              : undefined;
          if (!url) throw new GraphError("Image generation missing URL");
          imageUrlOut = url;
        }

        if (plan.needTextToVideo) {
          const body = await postGeneration({
            intent: "text-to-video",
            prompt: diffusionPrompt.slice(0, 8000),
            duration: data.videoDuration,
            resolution: data.videoResolution,
            silent: data.videoSilent,
            aspectRatio: "16:9",
          });
          const url =
            typeof (body.video as { url?: string } | undefined)?.url === "string"
              ? (body.video as { url: string }).url
              : undefined;
          if (!url) throw new GraphError("Text→video missing URL");
          videoUrlOut = url;
        }

        if (plan.needImageToVideo) {
          const imgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
          const imgUrl = imgs[0];
          if (!imgUrl) {
            throw new GraphError("Image→video needs an upstream image URL");
          }
          const body = await postGeneration({
            intent: "image-to-video",
            imageUrl: imgUrl,
            prompt: wanPrompt,
            durationSec: data.wanDurationSec,
            resolution: data.wanResolution,
          });
          const url =
            typeof (body.video as { url?: string } | undefined)?.url === "string"
              ? (body.video as { url: string }).url
              : undefined;
          if (!url) throw new GraphError("Image→video missing URL");
          videoUrlOut = url;
        }

        if (plan.needVideoToVideo) {
          const vidUrl = collectUpstreamVideoUrl(id, incomingByTarget, outputs);
          if (!vidUrl) {
            throw new GraphError("Video continuation needs an upstream video URL");
          }
          const body = await postGeneration({
            intent: "video-to-video",
            videoUrl: vidUrl,
            prompt: wanPrompt,
            durationSec: data.wanDurationSec,
            resolution: data.wanResolution,
          });
          const url =
            typeof (body.video as { url?: string } | undefined)?.url === "string"
              ? (body.video as { url: string }).url
              : undefined;
          if (!url) throw new GraphError("Video→video missing URL");
          videoUrlOut = url;
        }

        outputs[id] = {
          type: "generation",
          text: textOut,
          imageUrl: imageUrlOut,
          videoUrl: videoUrlOut,
        };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      case "platformExport": {
        const imageUrlsAll = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const videoUrl = collectUpstreamVideoUrl(id, incomingByTarget, outputs);
        const copy = collectUpstreamText(id, incomingByTarget, outputs);
        const caption = [copy.trim(), data.label].filter(Boolean).join("\n\n").slice(0, 2200);
        const description = [copy.trim(), data.label].filter(Boolean).join("\n\n").slice(0, 5000);

        if (data.platform === "youtube") {
          if (imageUrlsAll.length === 0 && !videoUrl) {
            throw new GraphError(
              "YouTube export needs an upstream image and/or video (wire the video handle for MP4 uploads).",
            );
          }
          const files: { path: string; blob: Blob }[] = [];
          if (imageUrlsAll[0]) {
            const imgRes = await fetch(imageUrlsAll[0]);
            if (!imgRes.ok) {
              logWorkflow("error", "runner/export", "YouTube image fetch failed", {
                nodeId: id,
                httpStatus: imgRes.status,
              });
              throw new GraphError("Failed to download image for export");
            }
            files.push({
              path: `platforms/youtube/creative.png`,
              blob: await imgRes.blob(),
            });
          }
          if (videoUrl) {
            const vr = await fetch(videoUrl);
            if (!vr.ok) {
              logWorkflow("error", "runner/export", "YouTube video fetch failed", {
                nodeId: id,
                httpStatus: vr.status,
              });
              throw new GraphError("Failed to download video for export");
            }
            files.push({
              path: `platforms/youtube/creative.mp4`,
              blob: await vr.blob(),
            });
          }
          const manifest = {
            platform: data.platform,
            title: data.label,
            copy,
            generatedAt: new Date().toISOString(),
            sourceImage: imageUrlsAll[0] ?? null,
            sourceVideo: videoUrl ?? null,
          };
          files.push({
            path: `platforms/youtube/manifest.json`,
            blob: new Blob([JSON.stringify(manifest, null, 2)], {
              type: "application/json",
            }),
          });
          const httpsVideo =
            videoUrl && /^https:\/\//i.test(videoUrl) ? videoUrl : undefined;
          outputs[id] = {
            type: "bundle",
            files,
            publishYoutube: httpsVideo
              ? {
                  videoUrl: httpsVideo,
                  title: data.label,
                  description,
                }
              : undefined,
          };
          onNodeComplete?.({
            nodeId: id,
            index: step + 1,
            total: totalSteps,
            label,
            output: outputs[id],
          });
          break;
        }

        const httpsImages = imageUrlsAll.filter((u) => /^https:\/\//i.test(u));
        if (httpsImages.length === 0) {
          throw new GraphError(
            `${data.platform} export needs at least one upstream image with a public https URL (from the generation block image pin).`,
          );
        }

        const primary = httpsImages[0];
        const imgRes = await fetch(primary);
        if (!imgRes.ok) {
          logWorkflow("error", "runner/export", "Meta/TikTok image fetch failed", {
            nodeId: id,
            platform: data.platform,
            httpStatus: imgRes.status,
          });
          throw new GraphError("Failed to download image for export");
        }
        const blob = await imgRes.blob();
        const manifest = {
          platform: data.platform,
          title: data.label,
          copy,
          generatedAt: new Date().toISOString(),
          sourceImage: primary,
          sourceImages: httpsImages,
        };
        const files: { path: string; blob: Blob }[] = [
          {
            path: `platforms/${data.platform}/creative.png`,
            blob,
          },
          {
            path: `platforms/${data.platform}/manifest.json`,
            blob: new Blob([JSON.stringify(manifest, null, 2)], {
              type: "application/json",
            }),
          },
        ];
        outputs[id] = {
          type: "bundle",
          files,
          publish:
            data.platform === "facebook" || data.platform === "instagram"
              ? {
                  platform: data.platform,
                  imageUrls: httpsImages.slice(0, 10),
                  caption,
                }
              : undefined,
        };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      default: {
        const _never: never = data;
        return _never;
      }
    }
  }

  onProgress?.({ phase: "done" });
  logWorkflow("info", "runner", "Workflow DAG run finished", {
    outputNodes: Object.keys(outputs).length,
  });
  return outputs;
}

export function wrapError(e: unknown): GraphError {
  if (e instanceof GraphError) return e;
  if (e instanceof Error) return new GraphError(e.message);
  return new GraphError("Unknown error");
}
