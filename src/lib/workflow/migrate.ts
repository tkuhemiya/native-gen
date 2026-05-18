import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";

import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  WORKFLOW_DOCUMENT_VERSION,
  clampVideoDurationSec,
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowEdge,
} from "./schema";

/** Remap legacy Flux Schnell nodes to unified generation blocks before validating current schema. */
export function coerceFluxToGeneration(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  const nodes = doc.nodes;
  if (!Array.isArray(nodes)) return raw;

  const nextNodes = nodes.map((node) => {
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const data = n.data;
    if (data === null || typeof data !== "object") return node;
    const d = data as Record<string, unknown>;
    if (n.type !== "falFluxSchnell" && d.kind !== "falFluxSchnell") return node;

    return {
      ...n,
      type: "generationBlock",
      data: {
        kind: "generationBlock",
        label: typeof d.label === "string" ? d.label : "Generate",
        suffix: typeof d.suffix === "string" ? d.suffix : "",
        imageSize: typeof d.imageSize === "string" ? d.imageSize : "landscape_4_3",
        numInferenceSteps:
          typeof d.numInferenceSteps === "number" ? d.numInferenceSteps : 2,
        locked: typeof d.locked === "boolean" ? d.locked : false,
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

const ALLOWED_VIDEO_RESOLUTION = new Set<string>(VIDEO_RESOLUTIONS);

/** Wan image-to-video accepts only `720p` | `1080p`; remap legacy values. */
export function coerceVideoBlockResolution(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  const nodes = doc.nodes;
  if (!Array.isArray(nodes)) return raw;

  const nextNodes = nodes.map((node) => {
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const data = n.data;
    if (data === null || typeof data !== "object") return node;
    const d = data as Record<string, unknown>;
    if (d.kind !== "videoBlock") return node;

    let resolution = d.resolution;
    if (resolution === "480p") resolution = "720p";
    const str = typeof resolution === "string" ? resolution : "";
    if (!ALLOWED_VIDEO_RESOLUTION.has(str)) resolution = "720p";

    return {
      ...n,
      data: {
        ...d,
        resolution,
        durationSec: clampVideoDurationSec(d.durationSec),
        locked: typeof d.locked === "boolean" ? d.locked : false,
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

function migrateMarketingNodesToStoryPrimitives(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = { ...(raw as Record<string, unknown>) };
  doc.version = WORKFLOW_DOCUMENT_VERSION;

  const nodes = doc.nodes;
  if (!Array.isArray(nodes)) return doc;

  const removedIds = new Set<string>();
  const nextNodes: unknown[] = [];

  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    const data = n.data;
    if (data === null || typeof data !== "object") {
      nextNodes.push(node);
      continue;
    }
    const d = data as Record<string, unknown>;
    const kind = d.kind;

    if (kind === "platformExport") {
      if (id) removedIds.add(id);
      continue;
    }

    if (kind === "mediaInput") {
      nextNodes.push({
        ...n,
        type: "textPrimitive",
        data: {
          kind: "textPrimitive",
          label: typeof d.label === "string" ? d.label : "Text",
          purpose: "",
          prompt: "",
          value: typeof d.value === "string" ? d.value : "",
          locked: false,
        },
      });
      continue;
    }

    if (kind === "generationBlock") {
      const sz =
        typeof d.imageSize === "string" && falFluxPresetSizeSchema.safeParse(d.imageSize).success
          ? d.imageSize
          : "portrait_16_9";
      nextNodes.push({
        ...n,
        type: "generationBlock",
        data: {
          kind: "generationBlock",
          label: typeof d.label === "string" ? d.label : "Generate still",
          suffix: typeof d.suffix === "string" ? d.suffix : "",
          imageSize: sz,
          numInferenceSteps:
            typeof d.numInferenceSteps === "number" ? d.numInferenceSteps : 2,
          locked: typeof d.locked === "boolean" ? d.locked : false,
        },
      });
      continue;
    }

    if (kind === "videoBlock") {
      nextNodes.push({
        ...n,
        type: "videoBlock",
        data: {
          kind: "videoBlock",
          label: typeof d.label === "string" ? d.label : "Animate clip",
          motionPrompt:
            typeof d.motionPrompt === "string"
              ? d.motionPrompt
              : "subtle cinematic motion",
          aspectRatio: (VIDEO_ASPECT_RATIOS as readonly string[]).includes(String(d.aspectRatio))
            ? (d.aspectRatio as (typeof VIDEO_ASPECT_RATIOS)[number])
            : "9:16",
          resolution:
            typeof d.resolution === "string" && ALLOWED_VIDEO_RESOLUTION.has(String(d.resolution))
              ? d.resolution
              : "720p",
          durationSec: clampVideoDurationSec(d.durationSec),
          locked: typeof d.locked === "boolean" ? d.locked : false,
        },
      });
      continue;
    }

    nextNodes.push(node);
  }

  let edges: WorkflowEdge[] = [];
  const rawEdges = doc.edges;
  if (Array.isArray(rawEdges)) {
    edges = rawEdges
      .filter((e) => {
        if (e === null || typeof e !== "object") return false;
        const edge = e as Record<string, unknown>;
        const source = typeof edge.source === "string" ? edge.source : "";
        const target = typeof edge.target === "string" ? edge.target : "";
        return !removedIds.has(source) && !removedIds.has(target);
      })
      .map((e) => {
        const edge = e as Record<string, unknown>;
        return {
          id: String(edge.id ?? crypto.randomUUID()),
          source: String(edge.source),
          target: String(edge.target),
          sourceHandle:
            edge.sourceHandle === undefined ? undefined : (edge.sourceHandle as string | null),
          targetHandle:
            edge.targetHandle === undefined ? undefined : (edge.targetHandle as string | null),
        };
      });
  }

  return { ...doc, nodes: nextNodes, edges };
}

/**
 * Accept current workflows; coerce legacy marketing nodes into story primitives (best-effort).
 */
export function normalizeWorkflowDocument(raw: unknown): WorkflowDocument | null {
  const pipe = migrateMarketingNodesToStoryPrimitives(
    coerceVideoBlockResolution(coerceFluxToGeneration(raw)),
  );
  const parsed = workflowDocumentSchema.safeParse(pipe);
  return parsed.success ? parsed.data : null;
}
