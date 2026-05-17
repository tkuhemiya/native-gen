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
  | {
      type: "generation";
      text?: string;
      imageUrl?: string;
    }
  | {
      type: "video";
      url: string;
      /** Source still passed into the video model (for previews + bundle copy). */
      sourceImageUrl?: string;
    }
  | {
      type: "mediaInput";
      text: string;
      imageUrls: string[];
    }
  | {
      type: "bundle";
      files: { path: string; blob: Blob }[];
      publish?: {
        platform: "facebook" | "instagram";
        imageUrls: string[];
        caption: string;
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
      if (edge.sourceHandle === "image") continue;
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
      if (edge.sourceHandle === "text") continue;
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

/**
 * Pull MP4 URLs from upstream `videoBlock` outputs that wire into this node's blue (image/media)
 * pin. Used by `platformExport` so a wired video flows into the export bundle as the primary
 * deliverable.
 */
function collectUpstreamVideoUrls(
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
    if (!upstream || upstream.type !== "video") continue;
    if (edge.sourceHandle !== "video") continue;
    const u = upstream.url;
    if (!u || seen.has(u)) continue;
    urls.push(u);
    seen.add(u);
  }
  return urls;
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
  if (trimmed.length > 16_000) {
    return [
      `Generation failed (${httpStatus}); response body very large (${trimmed.length} chars)`,
      trimmed.slice(0, 280),
    ].join(" — preview: ");
  }

  return `Generation failed (${httpStatus})`;
}

function generationCacheSatisfiesPlan(
  plan: GenerationPlan,
  cached: Extract<RuntimeOutputs[string], { type: "generation" }>,
): boolean {
  if (plan.needPassthroughText && !cached.text?.trim()) return false;
  if (plan.needCaption && !cached.text?.trim()) return false;
  if (plan.needMarketingSocialCopy && !cached.text?.trim()) return false;
  if (plan.needTextToImage && !cached.imageUrl) return false;
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
          "Sharp detail, advertising polish, brand-safe composition";

        async function postSocialMarketingCopy(body: {
          campaignBrief: string;
          productDescription?: string;
          sceneBrief?: string;
        }) {
          const res = await fetch("/api/workflow/social-copy", {
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
            /* non-JSON */
          }
          if (!res.ok) {
            const msg =
              typeof parsedBody.error === "string"
                ? parsedBody.error.trim()
                : `Social copy failed (${res.status})`;
            throw new GraphError(msg);
          }
          const text = typeof parsedBody.text === "string" ? parsedBody.text.trim() : "";
          if (!text) throw new GraphError("Social copy returned empty text");
          return text;
        }

        async function postGeneration(body: Record<string, unknown>) {
          const intent =
            typeof body.intent === "string" ? body.intent : "unknown";
          logWorkflow("info", "runner/fal", "Calling /api/fal/generation", {
            intent,
            promptChars:
              typeof body.prompt === "string" ? body.prompt.length : undefined,
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
        let productAnchor: string | undefined;

        const refImgsAll = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const refUrlForGen = refImgsAll[0];

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

        let imageGenPrompt =
          `${diffusionPrompt}\n\nMarketing poster still, campaign-ready composition.`.trim();
        if (refUrlForGen && plan.needTextToImage) {
          imageGenPrompt =
            `Preserve the exact product, packaging, logos, and readable label text from the reference photo; do not substitute a different SKU or conflicting branding.\n\nCreative direction:\n${diffusionPrompt}\n\nMarketing-poster composition with clean headline-safe margins.`.trim();
        }
        imageGenPrompt = imageGenPrompt.slice(0, 4000);

        if (plan.needTextToImage) {
          if (refUrlForGen) {
            const body = await postGeneration({
              intent: "image-to-image-edit",
              prompt: imageGenPrompt,
              imageSize: data.imageSize,
              imageUrls: [refUrlForGen],
            });
            const url =
              typeof (body.image as { url?: string } | undefined)?.url === "string"
                ? (body.image as { url: string }).url
                : undefined;
            if (!url) throw new GraphError("Image edit missing URL");
            imageUrlOut = url;
          } else {
            const body = await postGeneration({
              intent: "text-to-image",
              prompt: imageGenPrompt,
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
        }

        if (plan.needMarketingSocialCopy && plan.needReferenceImageEdit && refUrlForGen) {
          const cap = await postGeneration({
            intent: "image-to-text",
            imageUrl: refUrlForGen,
          });
          const caption =
            typeof cap.text === "string" ? cap.text.trim() : "";
          if (caption) productAnchor = caption;
        }

        if (plan.needMarketingSocialCopy) {
          const campaignBrief =
            [promptNotes, data.suffix.trim()].filter(Boolean).join("\n\n").trim() ||
            data.suffix.trim() ||
            diffusionPrompt;
          textOut = await postSocialMarketingCopy({
            campaignBrief,
            productDescription: productAnchor?.trim(),
            sceneBrief: diffusionPrompt.slice(0, 2500),
          });
        }

        outputs[id] = {
          type: "generation",
          text: textOut,
          imageUrl: imageUrlOut,
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
      case "videoBlock": {
        const refImgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const sourceImageUrl = refImgs[0];
        if (!sourceImageUrl) {
          throw new GraphError(
            "Video block needs an upstream image wired to its blue pin (e.g. from a generation block).",
          );
        }
        const upstreamText = collectUpstreamText(id, incomingByTarget, outputs).trim();
        const motion = data.motionPrompt.trim();
        const promptParts = [upstreamText, motion].filter(Boolean);
        const prompt = (promptParts.join("\n\n") || motion ||
          "smooth subtle parallax, gentle camera push-in, ad-ready motion").slice(0, 4000);

        const res = await fetch("/api/fal/generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent: "image-to-video",
            prompt,
            imageUrl: sourceImageUrl,
            aspectRatio: data.aspectRatio,
            resolution: data.resolution,
            durationSec: data.durationSec,
          }),
        });
        const rawText = await res.text();
        let parsedBody: Record<string, unknown> = {};
        try {
          const p = JSON.parse(rawText) as unknown;
          if (p && typeof p === "object" && !Array.isArray(p)) {
            parsedBody = p as Record<string, unknown>;
          }
        } catch {
          /* non-JSON */
        }
        if (!res.ok) {
          const msg = extractFalProxyErrorMessage(parsedBody, res.status, rawText);
          logWorkflow("error", "runner/fal", "Video generation HTTP error", {
            httpStatus: res.status,
            message: msg.slice(0, 4000),
          });
          throw new GraphError(msg);
        }
        const url =
          typeof (parsedBody.video as { url?: string } | undefined)?.url === "string"
            ? (parsedBody.video as { url: string }).url
            : undefined;
        if (!url) throw new GraphError("Video generation missing URL");

        outputs[id] = {
          type: "video",
          url,
          sourceImageUrl,
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
        const videoUrlsAll = collectUpstreamVideoUrls(id, incomingByTarget, outputs);
        const copy = collectUpstreamText(id, incomingByTarget, outputs);
        const caption = [copy.trim(), data.label].filter(Boolean).join("\n\n").slice(0, 2200);

        const httpsImages = imageUrlsAll.filter((u) => /^https:\/\//i.test(u));
        const httpsVideos = videoUrlsAll.filter((u) => /^https:\/\//i.test(u));
        if (httpsImages.length === 0 && httpsVideos.length === 0) {
          throw new GraphError(
            `${data.platform} export needs at least one upstream image or video with a public https URL (wire a generation block's image pin or a video block's violet pin into this export's blue pin).`,
          );
        }

        const files: { path: string; blob: Blob }[] = [];

        for (let i = 0; i < httpsVideos.length; i++) {
          const u = httpsVideos[i]!;
          const r = await fetch(u);
          if (!r.ok) {
            logWorkflow("error", "runner/export", "Export video fetch failed", {
              nodeId: id,
              platform: data.platform,
              httpStatus: r.status,
            });
            throw new GraphError("Failed to download video for export");
          }
          const blob = await r.blob();
          const ext = r.headers.get("content-type")?.includes("webm") ? "webm" : "mp4";
          const suffix = httpsVideos.length > 1 ? `-${i + 1}` : "";
          files.push({
            path: `platforms/${data.platform}/clip${suffix}.${ext}`,
            blob,
          });
        }

        if (httpsImages.length > 0) {
          const primary = httpsImages[0]!;
          const imgRes = await fetch(primary);
          if (!imgRes.ok) {
            logWorkflow("error", "runner/export", "Export image fetch failed", {
              nodeId: id,
              platform: data.platform,
              httpStatus: imgRes.status,
            });
            throw new GraphError("Failed to download image for export");
          }
          const blob = await imgRes.blob();
          files.push({
            path: `platforms/${data.platform}/creative.png`,
            blob,
          });
        }

        const manifest = {
          platform: data.platform,
          title: data.label,
          copy,
          generatedAt: new Date().toISOString(),
          sourceImage: httpsImages[0],
          sourceImages: httpsImages,
          sourceVideos: httpsVideos,
          /** True when at least one video is wired into this export — drives previews + publish hints. */
          hasVideo: httpsVideos.length > 0,
        };
        files.push({
          path: `platforms/${data.platform}/manifest.json`,
          blob: new Blob([JSON.stringify(manifest, null, 2)], {
            type: "application/json",
          }),
        });

        outputs[id] = {
          type: "bundle",
          files,
          publish:
            (data.platform === "facebook" || data.platform === "instagram") &&
            httpsImages.length > 0 &&
            httpsVideos.length === 0
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
