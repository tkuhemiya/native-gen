import { z } from "zod";

import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import {
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
        videos: [],
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
        videos: [],
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
        videos:
          d.dataUrl != null && d.dataUrl !== ""
            ? [{ dataUrl: d.dataUrl, fileName: d.fileName }]
            : [],
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
        videoDuration: "4s",
        videoResolution: "720p",
        videoSilent: true,
        wanDurationSec: 2,
        wanResolution: "720p",
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
        videoDuration:
          d.videoDuration === "4s" || d.videoDuration === "6s" || d.videoDuration === "8s"
            ? d.videoDuration
            : "4s",
        videoResolution:
          d.videoResolution === "1080p" || d.videoResolution === "720p"
            ? d.videoResolution
            : "720p",
        videoSilent: typeof d.videoSilent === "boolean" ? d.videoSilent : true,
        wanDurationSec:
          typeof d.wanDurationSec === "number"
            ? Math.min(15, Math.max(2, Math.floor(d.wanDurationSec)))
            : 2,
        wanResolution:
          d.wanResolution === "1080p" || d.wanResolution === "720p"
            ? d.wanResolution
            : "720p",
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

function bumpWorkflowVersion2To3(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  if (doc.version === 2) return { ...doc, version: WORKFLOW_DOCUMENT_VERSION };
  return raw;
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

    if (Array.isArray(d.images) && Array.isArray(d.videos)) {
      return node;
    }

    const images: { dataUrl: string; fileName?: string }[] = Array.isArray(d.images)
      ? (d.images as { dataUrl: string; fileName?: string }[])
      : [];
    const videos: { dataUrl: string; fileName?: string }[] = Array.isArray(d.videos)
      ? (d.videos as { dataUrl: string; fileName?: string }[])
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
    if (
      typeof d.videoDataUrl === "string" &&
      d.videoDataUrl !== ""
    ) {
      videos.push({
        dataUrl: d.videoDataUrl,
        fileName: typeof d.videoFileName === "string" ? d.videoFileName : undefined,
      });
    }

    const clean = { ...d } as Record<string, unknown>;
    delete clean.imageDataUrl;
    delete clean.imageFileName;
    delete clean.videoDataUrl;
    delete clean.videoFileName;

    return {
      ...n,
      data: {
        ...clean,
        images,
        videos,
      },
    };
  });

  return { ...doc, nodes: nextNodes };
}

/**
 * Accept v3 workflows; coerce legacy v2 Flux nodes → generation blocks;
 * migrate very old v1 documents (split input kinds).
 */
export function normalizeWorkflowDocument(raw: unknown): WorkflowDocument | null {
  const coerced = bumpWorkflowVersion2To3(
    coerceFluxToGeneration(coerceWorkflowDocumentRaw(raw)),
  );
  const v3 = workflowDocumentSchema.safeParse(coerced);
  if (v3.success) return v3.data;

  const v1 = v1WorkflowDocumentSchema.safeParse(raw);
  if (!v1.success) return null;

  const migrated = migrateV1Workflow(v1.data);
  const check = workflowDocumentSchema.safeParse(migrated);
  return check.success ? check.data : null;
}
