import { z } from "zod";

import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import {
  VIDEO_RESOLUTIONS,
  clampVideoDurationSec,
  WORKFLOW_DOCUMENT_VERSION,
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

const v1NodeDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("textInput"),
    label: z.string(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("imageInput"),
    label: z.string(),
    dataUrl: z.string().optional(),
    fileName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("videoInput"),
    label: z.string(),
    dataUrl: z.string().optional(),
    fileName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("falFluxSchnell"),
    label: z.string(),
    suffix: z.string(),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
  }),
  z.object({
    kind: z.literal("platformExport"),
    label: z.string(),
    platform: z.enum(["youtube", "facebook", "instagram", "tiktok"]),
  }),
]);

const v1WorkflowDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  version: z.literal(1),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      position: z.object({ x: z.number(), y: z.number() }),
      data: v1NodeDataSchema,
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      sourceHandle: z.string().nullable().optional(),
      targetHandle: z.string().nullable().optional(),
    }),
  ),
  updatedAt: z.string(),
});

function migrateNode(node: z.infer<typeof v1WorkflowDocumentSchema>["nodes"][number]): WorkflowNode {
  const d = node.data;
  if (d.kind === "textInput") {
    return {
      id: node.id,
      type: "mediaInput",
      position: node.position,
      data: {
        kind: "mediaInput",
        label: d.label,
        value: d.value,
        images: [],
      },
    };
  }
  if (d.kind === "imageInput") {
    return {
      id: node.id,
      type: "mediaInput",
      position: node.position,
      data: {
        kind: "mediaInput",
        label: d.label,
        value: "",
        images:
          d.dataUrl != null && d.dataUrl !== ""
            ? [{ dataUrl: d.dataUrl, fileName: d.fileName }]
            : [],
      },
    };
  }
  if (d.kind === "videoInput") {
    return {
      id: node.id,
      type: "mediaInput",
      position: node.position,
      data: {
        kind: "mediaInput",
        label: d.label,
        value: "",
        images: [],
      },
    };
  }
  if (d.kind === "falFluxSchnell") {
    return {
      id: node.id,
      type: "generationBlock",
      position: node.position,
      data: {
        kind: "generationBlock",
        label: d.label,
        suffix: d.suffix,
        imageSize: d.imageSize,
        numInferenceSteps: d.numInferenceSteps,
      },
    };
  }
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: d,
  } as WorkflowNode;
}

function migrateV1Workflow(v1: z.infer<typeof v1WorkflowDocumentSchema>): WorkflowDocument {
  const nodes = v1.nodes.map(migrateNode);
  const edges: WorkflowEdge[] = v1.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));
  return {
    id: v1.id,
    name: v1.name,
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
}

/** v2 workflows stored Flux Schnell nodes — remap to unified generation blocks before validating v3. */
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
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

function readDocumentVersion(raw: unknown): number | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).version;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bumpWorkflowVersionToCurrent(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  const v = doc.version;
  if (v === 2 || v === 3 || v === 4) {
    return { ...doc, version: WORKFLOW_DOCUMENT_VERSION };
  }
  return raw;
}

/**
 * Cleans up a botched pre-v5 video attempt that stored video fields on `generationBlock` and
 * `mediaInput`. We only strip when the doc is from before v5 — once we're at v5 the dedicated
 * `videoBlock` node owns video and `video` source/target handles are first-class.
 */
function stripLegacyVideoArtifactsIfPreV5(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const version = readDocumentVersion(raw);
  if (version != null && version >= WORKFLOW_DOCUMENT_VERSION) return raw;

  const doc = raw as Record<string, unknown>;

  /**
   * Edges going to/from a `videoBlock` keep their video handles. Edges with `video` handles
   * touching only legacy generationBlocks are dropped (those nodes lost their video output).
   */
  const nodeKindById = new Map<string, string>();
  if (Array.isArray(doc.nodes)) {
    for (const n of doc.nodes as Record<string, unknown>[]) {
      const id = typeof n.id === "string" ? n.id : "";
      const data = n.data as Record<string, unknown> | undefined;
      const kind = typeof data?.kind === "string" ? data.kind : "";
      if (id) nodeKindById.set(id, kind);
    }
  }

  const edges = Array.isArray(doc.edges)
    ? (doc.edges as Record<string, unknown>[]).filter((e) => {
        const sh = e.sourceHandle ?? null;
        const th = e.targetHandle ?? null;
        const sourceKind = nodeKindById.get(String(e.source));
        const targetKind = nodeKindById.get(String(e.target));
        const isVideoHandle = sh === "video" || th === "video";
        if (!isVideoHandle) return true;
        return sourceKind === "videoBlock" || targetKind === "videoBlock";
      })
    : [];

  const nodes = Array.isArray(doc.nodes)
    ? (doc.nodes as Record<string, unknown>[]).map((node) => {
        const data = node.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== "object") return node;
        if (data.kind === "mediaInput") {
          const { videos: _v, ...rest } = data;
          return {
            ...node,
            data: {
              ...rest,
              images: Array.isArray(rest.images) ? rest.images : [],
            },
          };
        }
        if (data.kind === "generationBlock") {
          const {
            videoDuration: _vd,
            videoResolution: _vr,
            videoSilent: _vs,
            wanDurationSec: _wd,
            wanResolution: _wr,
            ...rest
          } = data;
          return { ...node, data: rest };
        }
        return node;
      })
    : [];

  return {
    ...doc,
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
    updatedAt:
      typeof doc.updatedAt === "string" && doc.updatedAt.trim()
        ? doc.updatedAt
        : new Date().toISOString(),
  };
}

/** Converts legacy per-node `imageDataUrl` / `videoDataUrl` into `images` / `videos` arrays. */
export function coerceWorkflowDocumentRaw(raw: unknown): unknown {
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
    if (d.kind !== "mediaInput") return node;

    if (Array.isArray(d.images) && !d.imageDataUrl && !d.videoDataUrl) {
      const { videos: _drop, ...rest } = d;
      return {
        ...n,
        data: {
          ...rest,
          images: Array.isArray(rest.images) ? rest.images : [],
        },
      };
    }

    const images: { dataUrl: string; fileName?: string }[] = Array.isArray(d.images)
      ? (d.images as { dataUrl: string; fileName?: string }[])
      : [];

    if (
      typeof d.imageDataUrl === "string" &&
      d.imageDataUrl !== ""
    ) {
      images.push({
        dataUrl: d.imageDataUrl,
        fileName: typeof d.imageFileName === "string" ? d.imageFileName : undefined,
      });
    }

    const clean = { ...d } as Record<string, unknown>;
    delete clean.imageDataUrl;
    delete clean.imageFileName;
    delete clean.videoDataUrl;
    delete clean.videoFileName;
    delete clean.videos;

    return {
      ...n,
      data: {
        ...clean,
        images,
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

const ALLOWED_VIDEO_RESOLUTION = new Set<string>(VIDEO_RESOLUTIONS);

/** fal-ai Wan image-to-video accepts only `720p` | `1080p`; remap legacy `480p` / invalid values. */
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
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

/**
 * Accept current workflows; coerce legacy nodes; strip obsolete video wiring from pre-v5 docs.
 *
 * v5 introduced the dedicated `videoBlock` node and first-class `video` handles, so docs at v5+
 * are passed through as-is once they validate.
 */
export function normalizeWorkflowDocument(raw: unknown): WorkflowDocument | null {
  const coerced = stripLegacyVideoArtifactsIfPreV5(
    bumpWorkflowVersionToCurrent(
      coerceFluxToGeneration(coerceVideoBlockResolution(coerceWorkflowDocumentRaw(raw))),
    ),
  );
  const current = workflowDocumentSchema.safeParse(coerced);
  if (current.success) return current.data;

  const v1 = v1WorkflowDocumentSchema.safeParse(raw);
  if (!v1.success) return null;

  const migrated = migrateV1Workflow(v1.data);
  const check = workflowDocumentSchema.safeParse(
    coerceVideoBlockResolution(stripLegacyVideoArtifactsIfPreV5(migrated)),
  );
  return check.success ? check.data : null;
}
