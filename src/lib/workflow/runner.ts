import {
  assertConnectedDAG,
  GraphError,
  sortedIncomingClipEdgesForJoin,
  topologicalWavesPreferLeft,
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
  step?: {
    index: number;
    total: number;
    nodeId: string;
    /** Set when multiple generation nodes run in the same wave. */
    runningNodeIds?: string[];
  };
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

const DEFAULT_MAX_CONCURRENT_GENERATIONS = 8;

export type RunWorkflowOptions = {
  onProgress?: (p: RunProgress) => void;
  onNodeComplete?: (e: NodeRunComplete) => void;
  /** Cap parallel fal still / video jobs per wave. Default 8. */
  maxConcurrentGenerations?: number;
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
    if (upstream.type === "sceneContext") {
      if (edge.sourceHandle === "script") {
        const t = upstream.script?.trim();
        if (t) parts.push(t);
      }
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

type FalGenerationLogMeta = {
  logNodeId: string;
  logLabel: string;
};

/** POST /api/fal/generation — surfaces network failures and HTTP status in GraphError messages. */
async function fetchFalGenerationJson(
  body: Record<string, unknown>,
  log?: FalGenerationLogMeta,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch("/api/fal/generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log ? { ...body, ...log } : body),
    });
  } catch (e) {
    const net = e instanceof Error ? e.message : String(e);
    throw new GraphError(
      `Could not reach /api/fal/generation (${net}). Check that the app is running and the network is available.`,
    );
  }
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
    const http = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    throw new GraphError(`${msg} (${http})`.trim());
  }
  return parsedBody;
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

  while (true) {
    let res: Response;
    try {
      res = await fetch("/api/workflow/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips, transitions: current }),
      });
    } catch (e) {
      const net = e instanceof Error ? e.message : String(e);
      throw new GraphError(
        `Could not reach /api/workflow/assemble (${net}). Check that the app is running and ffmpeg is available on the server.`,
      );
    }
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

    throw new GraphError(
      `${extractFalProxyErrorMessage(parsedBody, res.status, rawText)} (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`.trim(),
    );
  }
}

function isParallelGenerationKind(kind: WorkflowNode["data"]["kind"]): boolean {
  return kind === "generationBlock" || kind === "videoBlock";
}

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  }
  const pool = Math.min(Math.max(1, limit), tasks.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

export async function runWorkflowDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: RunWorkflowOptions = {},
): Promise<RuntimeOutputs> {
  if (nodes.length === 0) {
    throw new GraphError("Add at least one node before running");
  }

  const {
    onProgress,
    onNodeComplete,
    reuseOutputs: reuseOutputsRaw,
    onAssembleBridgeFailure,
    maxConcurrentGenerations = DEFAULT_MAX_CONCURRENT_GENERATIONS,
  } = options;
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
  const waves = topologicalWavesPreferLeft(nodes, edges);
  const totalSteps = nodes.length;
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = incomingByTarget.get(e.target) ?? [];
    list.push(e);
    incomingByTarget.set(e.target, list);
  }

  const outputs: RuntimeOutputs = {};
  let completedCount = 0;

  onProgress?.({ phase: "running", message: "Executing workflow…" });

  async function runNode(id: string): Promise<{
    output: RuntimeOutputs[string];
    reused?: boolean;
  }> {
    const node = nodesById.get(id)!;
    const data = node.data;
    const label = runLabel(node);

    logWorkflow("debug", "runner/node", "Visit node", {
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
          return { output: reuseOutputs[id], reused: true };
        }
        let value: string;
        if (data.locked) {
          const chunks = [data.prompt.trim(), data.value.trim()].filter(Boolean);
          value = chunks.join("\n\n").trim() || data.value.trim();
        } else {
          const upstream = collectUpstreamText(id, incomingByTarget, outputs);
          const chunks = [upstream, data.prompt.trim(), data.value.trim()].filter(Boolean);
          value = chunks.join("\n\n").trim() || data.value.trim();
        }
        return { output: { type: "text", value } };
      }
      case "imagePrimitive": {
        const localUrl = data.image?.dataUrl;
        if (data.locked && reuseOutputs && reuseOutputs[id]?.type === "image") {
          const cached = reuseOutputs[id];
          if (cached.url?.trim()) {
            return { output: cached, reused: true };
          }
        }
        if (data.locked) {
          const url = localUrl && localUrl.trim();
          if (!url) {
            throw new GraphError(
              `Image primitive “${label}” is locked and needs an uploaded still (upstream image merge is disabled)`,
            );
          }
          return { output: { type: "image", url: url.trim() } };
        }
        const upstreamUrls = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const url = (localUrl && localUrl.trim()) || upstreamUrls[0];
        if (!url?.trim()) {
          throw new GraphError(
            `Image primitive “${label}” needs an uploaded still or an upstream generated image wired to its image pin`,
          );
        }
        return { output: { type: "image", url: url.trim() } };
      }
      case "sceneCompose": {
        if (
          data.locked &&
          reuseOutputs &&
          reuseOutputs[id]?.type === "sceneContext"
        ) {
          return { output: reuseOutputs[id], reused: true };
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
        return {
          output: {
            type: "sceneContext",
            script: script.trim(),
            imageAUrl: imgA,
            imageBUrl: imgB,
          },
        };
      }
      case "sceneJoin": {
        const clipEdges = sortedIncomingClipEdgesForJoin(id, edges);
        const orderedSources = clipEdges.map((e) => e.source);
        if (orderedSources.length === 0) {
          throw new GraphError(`Join “${label}” needs at least one clip wired to the clips pin`);
        }
        const clips: string[] = [];
        for (const clipId of orderedSources) {
          const o = outputs[clipId];
          if (!o || o.type !== "video") {
            throw new GraphError(
              `Join “${label}” references clip node ${clipId.slice(0, 8)}… but it has no video output yet`,
            );
          }
          clips.push(o.url);
        }
        const trans = normalizeJoinTransitions(orderedSources.length, data.transitions);
        const assembledUrl = await assembleClipsWithBridgeHandling(
          clips,
          trans,
          onAssembleBridgeFailure,
        );
        return { output: { type: "video", url: assembledUrl } };
      }
      case "outputBlock": {
        const vid = collectUpstreamVideoUrls(id, incomingByTarget, outputs)[0];
        if (vid) {
          const upstream = [...sortedIncomingEdges(id, incomingByTarget)]
            .map((e) => outputs[e.source])
            .find((o) => o?.type === "video");
          return {
            output: {
              type: "video",
              url: vid,
              sourceImageUrl: upstream?.type === "video" ? upstream.sourceImageUrl : undefined,
            },
          };
        }
        const imgs = collectUpstreamImageUrls(id, incomingByTarget, outputs);
        const img = imgs[0];
        if (!img) {
          throw new GraphError(
            `Output “${label}” needs one upstream image or video wired to its media pin`,
          );
        }
        return { output: { type: "image", url: img } };
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
            logWorkflow("info", "runner/node", "Skipped generation (locked + prior output)", {
              nodeId: id,
              label,
            });
            return { output: cached, reused: true };
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

        const falLog: FalGenerationLogMeta = { logNodeId: id, logLabel: label };

        async function postGeneration(body: Record<string, unknown>) {
          const intent =
            typeof body.intent === "string" ? body.intent : "unknown";
          logWorkflow("info", "runner/fal", "Calling /api/fal/generation", {
            intent,
            nodeId: id,
            label,
          });
          return fetchFalGenerationJson(body, falLog);
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

        return {
          output: {
            type: "generation",
            text: textOut,
            imageUrl: imageUrlOut,
          },
        };
      }
      case "videoBlock": {
        if (data.locked && reuseOutputs && reuseOutputs[id]?.type === "video") {
          return { output: reuseOutputs[id], reused: true };
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

        const parsedBody = await fetchFalGenerationJson(
          {
            intent: "image-to-video",
            prompt,
            imageUrl: sourceImageUrl,
            aspectRatio: data.aspectRatio,
            resolution: data.resolution,
            durationSec: data.durationSec,
          },
          { logNodeId: id, logLabel: label },
        );
        const url =
          typeof (parsedBody.video as { url?: string } | undefined)?.url === "string"
            ? (parsedBody.video as { url: string }).url
            : undefined;
        if (!url) throw new GraphError("Video generation missing URL");

        return {
          output: {
            type: "video",
            url,
            sourceImageUrl,
          },
        };
      }
      default: {
        const _never: never = data;
        return _never;
      }
    }
  }

  function finishNode(
    id: string,
    result: { output: RuntimeOutputs[string]; reused?: boolean },
  ) {
    const label = runLabel(nodesById.get(id)!);
    outputs[id] = result.output;
    completedCount += 1;
    onNodeComplete?.({
      nodeId: id,
      index: completedCount,
      total: totalSteps,
      label,
      output: result.output,
      reused: result.reused,
    });
  }

  for (const wave of waves) {
    const light = wave.filter(
      (id) => !isParallelGenerationKind(nodesById.get(id)!.data.kind),
    );
    const heavy = wave.filter((id) =>
      isParallelGenerationKind(nodesById.get(id)!.data.kind),
    );

    for (const id of light) {
      const label = runLabel(nodesById.get(id)!);
      onProgress?.({
        phase: "running",
        message: `${completedCount + 1}/${totalSteps} · ${label}`,
        step: { index: completedCount + 1, total: totalSteps, nodeId: id },
      });
      finishNode(id, await runNode(id));
    }

    if (heavy.length === 0) continue;

    const heavyLabels = heavy.map((id) => runLabel(nodesById.get(id)!));
    const waveStart = completedCount + 1;
    const waveEnd = completedCount + heavy.length;
    onProgress?.({
      phase: "running",
      message:
        heavy.length > 1
          ? `${waveStart}–${waveEnd}/${totalSteps} · Generating ${heavy.length} in parallel (${heavyLabels.join(", ")})`
          : `${waveStart}/${totalSteps} · ${heavyLabels[0]}`,
      step: {
        index: waveStart,
        total: totalSteps,
        nodeId: heavy[0]!,
        runningNodeIds: heavy,
      },
    });

    logWorkflow("info", "runner", "Parallel generation wave", {
      nodeIds: heavy,
      count: heavy.length,
      maxConcurrentGenerations,
    });

    const heavyResults = await runWithConcurrencyLimit(
      heavy.map((id) => async () => ({ id, ...(await runNode(id)) })),
      maxConcurrentGenerations,
    );

    for (const { id, output, reused } of heavyResults) {
      finishNode(id, { output, reused });
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
  if (e instanceof Error) {
    let m = e.message || "Error";
    if (e.cause !== undefined) {
      const c = e.cause instanceof Error ? e.cause.message : String(e.cause);
      if (c) m = `${m} — cause: ${c}`;
    }
    return new GraphError(m);
  }
  return new GraphError("Unknown error");
}
