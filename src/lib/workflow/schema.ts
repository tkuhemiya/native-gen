import { z } from "zod";

export const WORKFLOW_DOCUMENT_VERSION = 2 as const;

const mediaAssetSchema = z.object({
  dataUrl: z.string(),
  fileName: z.string().optional(),
});

export type MediaInputAsset = z.infer<typeof mediaAssetSchema>;

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const baseNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: positionSchema,
});

export const nodeDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mediaInput"),
    label: z.string(),
    value: z.string(),
    images: z.array(mediaAssetSchema).default([]),
    videos: z.array(mediaAssetSchema).default([]),
  }),
  z.object({
    kind: z.literal("falFluxSchnell"),
    label: z.string(),
    suffix: z.string(),
    imageSize: z.enum(["square_hd", "landscape_4_3", "portrait_4_3"]),
    numInferenceSteps: z.number().min(1).max(12),
  }),
  z.object({
    kind: z.literal("platformExport"),
    label: z.string(),
    platform: z.enum(["youtube", "facebook", "instagram", "tiktok"]),
    /** Facebook Page ID for Meta publish (Facebook or Instagram). */
    metaPageId: z.string().optional(),
  }),
]);

export const workflowNodeSchema = baseNodeSchema.extend({
  data: nodeDataSchema,
});

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
});

export const workflowDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  version: z.literal(WORKFLOW_DOCUMENT_VERSION),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  updatedAt: z.string(),
});

export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type NodeData = z.infer<typeof nodeDataSchema>;

export const NODE_TYPES = [
  "mediaInput",
  "falFluxSchnell",
  "platformExport",
] as const;

export type CanvasNodeType = (typeof NODE_TYPES)[number];

export function defaultNodeData(type: CanvasNodeType): NodeData {
  switch (type) {
    case "mediaInput":
      return {
        kind: "mediaInput",
        label: "Campaign input",
        value: "",
        images: [],
        videos: [],
      };
    case "falFluxSchnell":
      return {
        kind: "falFluxSchnell",
        label: "Flux Schnell",
        suffix: ", high quality ad creative, clean composition",
        imageSize: "landscape_4_3",
        numInferenceSteps: 4,
      };
    case "platformExport":
      return {
        kind: "platformExport",
        label: "YouTube export",
        platform: "youtube",
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
