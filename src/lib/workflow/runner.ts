import {
  assertConnectedDAG,
  GraphError,
  topologicalOrderPreferLeft,
  withSceneJoinSyntheticEdges,
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
      type: "sceneContext";
      script: string;
      imageAUrl: string;
      imageBUrl: string;
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
  reused?: boolean;
};

export type AssembleBridgeFailureInfo = {
  gapIndex: number;
  message: string;
};

export type RunWorkflowOptions = {
  onProgress?: (p: RunProgress) => void;
  onNodeComplete?: (e: NodeRunComplete) => void;
  reuseOutputs?: RuntimeOutputs;
  /**
   * When server assembly hits an unsupported bridge gap, choose retry/cut/abort.
   * If omitted, bridge gaps throw {@link GraphError}.
   */
  onAssembleBridgeFailure?: (
    info: AssembleBridgeFailureInfo,
  ) => Promise<"retry" | "cut" | "abort">;
};

function runLabel(node: WorkflowNode): string {
  return node.data.label.trim() || node.data.kind;
}

function isTextTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && (edge.targetHandle == null || edge.targetHandle === "text");
}

function isImageTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return (
    edge.target === nodeId &&
    (edge.targetHandle === "image" ||
      edge.targetHandle === "imageA" ||
      edge.targetHandle === "imageB" ||
      edge.targetHandle === "media")
  );
}

function isScriptTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && edge.targetHandle === "script";
}

function isImageATargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && edge.targetHandle === "imageA";
}

function isImageBTargetEdge(edge: WorkflowEdge, nodeId: string) {
  return edge.target === nodeId && edge.targetHandle === "imageB";
}

/** Incoming text contributors sorted by upstream node id for deterministic merges. */
function sortedIncomingEdges(nodeId: string, incomingByTarget: Map<string, WorkflowEdge[]>) {
  const incoming = [...(incomingByTarget.get(nodeId) ?? [])];
  incoming.sort((a, b) => a.source.localeCompare(b.source));
  return incoming;
}

function collectUpstreamText(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string {
  const parts: string[] = [];
  for (const edge of sortedIncomingEdges(nodeId, incomingByTarget)) {
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
  }
  return parts.join("\n\n").trim();
}

function collectScriptForScene(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string {
  const parts: string[] = [];
  for (const edge of sortedIncomingEdges(nodeId, incomingByTarget)) {
    if (!isScriptTargetEdge(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    if (upstream.type === "text") {
      if (upstream.value.trim()) parts.push(upstream.value.trim());
    }
    if (upstream.type === "generation" && edge.sourceHandle === "text") {
      const t = upstream.text?.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n").trim();
}

function pullImageUrlFromOutput(
  edge: WorkflowEdge,
  upstream: RuntimeOutputs[string] | undefined,
): string | undefined {
  if (!upstream) return undefined;
  if (upstream.type === "image" && upstream.url) {
    if (edge.sourceHandle === "text") return undefined;
    return upstream.url;
  }
  if (upstream.type === "generation") {
    const u = upstream.imageUrl;
    if (u && edge.sourceHandle === "image") return u;
    return undefined;
  }
  if (upstream.type === "sceneContext") {
    const sh = edge.sourceHandle;
    if (sh === "imageA") return upstream.imageAUrl;
    if (sh === "imageB") return upstream.imageBUrl;
  }
  return undefined;
}

function collectOneImageForScenePin(
  nodeId: string,
  pinTest: (e: WorkflowEdge, id: string) => boolean,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string | undefined {
  for (const edge of sortedIncomingEdges(nodeId, incomingByTarget)) {
    if (!pinTest(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    const u = pullImageUrlFromOutput(edge, upstream);
    if (u) return u;
  }
  return undefined;
}

function collectUpstreamImageUrls(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const edge of sortedIncomingEdges(nodeId, incomingByTarget)) {
    if (!isImageTargetEdge(edge, nodeId)) continue;
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    const u = pullImageUrlFromOutput(edge, upstream);
    if (u && !seen.has(u)) {
      urls.push(u);
      seen.add(u);
    }
  }
  return urls;
}

function collectUpstreamVideoUrls(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string[] {
  const incoming = sortedIncomingEdges(nodeId, incomingByTarget);
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

function extractFalProxyErrorMessage(
  body: Record<string, unknown>,
  httpStatus: number,
  rawText: string,
): string {
  const errStr = body.error;
  if (typeof errStr === "string" && errStr.trim()) return errStr.trim();

  const detail = body.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();

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
  return true;
}

function normalizeJoinTransitions(
  clipCount: number,
  transitions: { mode: "cut" | "bridge"; bridgePrompt?: string }[],
): { mode: "cut" | "bridge"; bridgePrompt?: string }[] {
  const n = Math.max(0, clipCount - 1);
  const out: { mode: "cut" | "bridge"; bridgePrompt?: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(transitions[i] ?? { mode: "cut" });
  }
  return out;
}

async function assembleClipsWithBridgeHandling(
  clips: string[],
  transitions: { mode: "cut" | "bridge"; bridgePrompt?: string }[],
  onAssembleBridgeFailure: RunWorkflowOptions["onAssembleBridgeFailure"],
): Promise<string> {
  let current = normalizeJoinTransitions(clips.length, transitions);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch("/api/workflow/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips, transitions: current }),
    });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") ?? "";

    if (res.ok) {
      const mime = ct.includes("webm") ? "video/webm" : "video/mp4";
      const b = new Blob([buf], { type: mime });
      return URL.createObjectURL(b);
    }

    const rawText = new TextDecoder().decode(buf);
    let parsedBody: Record<string, unknown> = {};
    try {
      const p = JSON.parse(rawText) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        parsedBody = p as Record<string, unknown>;
      }
    } catch {
      /* non-json */
    }

    const code =
      typeof parsedBody.code === "string" ? parsedBody.code : "";
    const gapIndexRaw = parsedBody.gapIndex;
    const gapIndex =
      typeof gapIndexRaw === "number" && Number.isFinite(gapIndexRaw)
        ? gapIndexRaw
        : -1;

    if (
      res.status === 422 &&
      code === "bridge_gap_unsupported" &&
      onAssembleBridgeFailure &&
      gapIndex >= 0
    ) {
      const choice = await onAssembleBridgeFailure({
        gapIndex,
        message:
          typeof parsedBody.error === "string"
            ? parsedBody.error
            : "Bridge transition is not supported yet on the server.",
      });
      if (choice === "abort") {
        throw new GraphError("Scene assembly aborted");
      }
      if (choice === "cut") {
        const next = [...current];
        if (gapIndex < next.length) {
          next[gapIndex] = { mode: "cut" };
        }
        current = next;
        continue;
      }
      throw new GraphError(
        "Bridge transition is not available on the server yet — pick **Cut** to continue, or edit the Join block.",
      );
    }

    throw new GraphError(extractFalProxyErrorMessage(parsedBody, res.status, rawText));
  }
}

export async function runWorkflowDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: RunWorkflowOptions = {},
): Promise<RuntimeOutputs> {
  if (nodes.length === 0) {
    throw new GraphError("Add at least one node before running");
  }

  const { onProgress, onNodeComplete, reuseOutputs: reuseOutputsRaw, onAssembleBridgeFailure } =
    options;
  const reuseOutputs =
    reuseOutputsRaw && Object.keys(reuseOutputsRaw).length > 0
      ? reuseOutputsRaw
      : undefined;

  logWorkflow("info", "runner", "Workflow DAG run started", {
    nodes: nodes.length,
    edges: edges.length,
    reuseCandidates: reuseOutputs ? Object.keys(reuseOutputs).length : 0,
  });

  const graphEdges = withSceneJoinSyntheticEdges(nodes, edges);
  assertConnectedDAG(nodes, graphEdges);
  const order = topologicalOrderPreferLeft(nodes, graphEdges);
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
      case "textPrimitive": {
        if (
          data.locked &&
          reuseOutputs &&
          reuseOutputs[id]?.type === "text" &&
          reuseOutputs[id].value.trim()
        ) {
          const cached = reuseOutputs[id];
          outputs[id] = cached;
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
        const upstream = collectUpstreamText(id, incomingByTarget, outputs);
        const chunks = [upstream, data.prompt.trim(), data.value.trim()].filter(Boolean);
        const value = chunks.join("\n\n").trim() || data.value.trim();
        outputs[id] = { type: "text", value };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      case "imagePrimitive": {
        const localUrl = data.image?.dataUrl;
        if (data.locked && reuseOutputs && reuseOutputs[id]?.type === "image") {
          const cached = reuseOutputs[id];
          if (cached.url?.trim()) {
            outputs[id] = cached;
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
        const upstreamUrls = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const url = (localUrl && localUrl.trim()) || upstreamUrls[0];
        if (!url?.trim()) {
          throw new GraphError(
            `Image primitive “${label}” needs an uploaded still or an upstream generated image wired to its image pin`,
          );
        }
        outputs[id] = { type: "image", url: url.trim() };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      case "sceneCompose": {
        if (
          data.locked &&
          reuseOutputs &&
          reuseOutputs[id]?.type === "sceneContext"
        ) {
          const cached = reuseOutputs[id];
          outputs[id] = cached;
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
        const script = collectScriptForScene(id, incomingByTarget, outputs);
        const imgA = collectOneImageForScenePin(
          id,
          isImageATargetEdge,
          incomingByTarget,
          outputs,
        );
        const imgB = collectOneImageForScenePin(
          id,
          isImageBTargetEdge,
          incomingByTarget,
          outputs,
        );
        if (!script.trim()) {
          throw new GraphError(`Scene “${label}” needs script text wired to the script pin`);
        }
        if (!imgA || !imgB) {
          throw new GraphError(
            `Scene “${label}” needs two stills wired to image A and image B pins`,
          );
        }
        outputs[id] = {
          type: "sceneContext",
          script: script.trim(),
          imageAUrl: imgA,
          imageBUrl: imgB,
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
      case "sceneJoin": {
        const ordered = data.orderedClipNodeIds;
        if (ordered.length === 0) {
          throw new GraphError(`Join “${label}” needs at least one clip id in its ordered list`);
        }
        const clips: string[] = [];
        for (const clipId of ordered) {
          const o = outputs[clipId];
          if (!o || o.type !== "video") {
            throw new GraphError(
              `Join “${label}” references clip node ${clipId.slice(0, 8)}… but it has no video output yet`,
            );
          }
          clips.push(o.url);
        }
        const trans = normalizeJoinTransitions(ordered.length, data.transitions);
        const assembledUrl = await assembleClipsWithBridgeHandling(
          clips,
          trans,
          onAssembleBridgeFailure,
        );
        outputs[id] = { type: "video", url: assembledUrl };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      case "outputBlock": {
        const vid = collectUpstreamVideoUrls(id, incomingByTarget, outputs)[0];
        if (vid) {
          const upstream = [...sortedIncomingEdges(id, incomingByTarget)]
            .map((e) => outputs[e.source])
            .find((o) => o?.type === "video");
          outputs[id] = {
            type: "video",
            url: vid,
            sourceImageUrl: upstream?.type === "video" ? upstream.sourceImageUrl : undefined,
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
        const imgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const img = imgs[0];
        if (!img) {
          throw new GraphError(
            `Output “${label}” needs one upstream image or video wired to its media pin`,
          );
        }
        outputs[id] = { type: "image", url: img };
        onNodeComplete?.({
          nodeId: id,
          index: step + 1,
          total: totalSteps,
          label,
          output: outputs[id],
        });
        break;
      }
      case "generationBlock": {
        const inL = incomingMediaLanes(id, incomingByTarget);
        const outL = outgoingMediaLanes(id, edges);
        const plan = planGeneration(inL, outL);

        if (data.locked && reuseOutputs) {
          const cached = reuseOutputs[id];
          if (
            cached?.type === "generation" &&
            generationCacheSatisfiesPlan(plan, cached)
          ) {
            outputs[id] = cached;
            logWorkflow("info", "runner/node", "Skipped generation (locked + prior output)", {
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
            ? `${promptNotes ? "\n\n" : ""}${data.suffix.trim()}`
            : "");
        const diffusionPrompt =
          promptBody.trim() ||
          data.suffix.trim() ||
          "Cinematic story still, cohesive world, emotionally readable moment";

        async function postGeneration(body: Record<string, unknown>) {
          const intent =
            typeof body.intent === "string" ? body.intent : "unknown";
          logWorkflow("info", "runner/fal", "Calling /api/fal/generation", {
            intent,
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
            /* non-json */
          }
          if (!res.ok) {
            const msg = extractFalProxyErrorMessage(parsedBody, res.status, rawText);
            throw new GraphError(msg);
          }
          return parsedBody as Record<string, unknown>;
        }

        let textOut: string | undefined;
        let imageUrlOut: string | undefined;

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
          `${diffusionPrompt}\n\nHigh-quality story illustration frame.`.trim();
        if (refUrlForGen && plan.needTextToImage) {
          imageGenPrompt =
            `Maintain identity, wardrobe, and environmental continuity with the reference still.\n\n${imageGenPrompt}`.trim();
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
        if (data.locked && reuseOutputs && reuseOutputs[id]?.type === "video") {
          const cached = reuseOutputs[id];
          outputs[id] = cached;
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
        const refImgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const sourceImageUrl = refImgs[0];
        if (!sourceImageUrl) {
          throw new GraphError(
            `Video block “${label}” needs an upstream still wired to its image pin`,
          );
        }
        const upstreamText = collectUpstreamText(id, incomingByTarget, outputs).trim();
        const motion = data.motionPrompt.trim();
        const promptParts = [upstreamText, motion].filter(Boolean);
        const prompt = (promptParts.join("\n\n") || motion ||
          "smooth subtle motion, continuity-friendly camera move").slice(0, 4000);

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
          /* non-json */
        }
        if (!res.ok) {
          const msg = extractFalProxyErrorMessage(parsedBody, res.status, rawText);
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
