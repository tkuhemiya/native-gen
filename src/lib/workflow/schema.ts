import { z } from "zod";

export const WORKFLOW_DOCUMENT_VERSION = 1 as const;

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
    imageSize: z.enum(["square_hd", "landscape_4_3", "portrait_4_3"]),
    numInferenceSteps: z.number().min(1).max(12),
  }),
  z.object({
    kind: z.literal("platformExport"),
    label: z.string(),
    platform: z.enum(["youtube", "facebook", "instagram", "tiktok"]),
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
  "textInput",
  "imageInput",
  "videoInput",
  "falFluxSchnell",
  "platformExport",
] as const;

export type CanvasNodeType = (typeof NODE_TYPES)[number];

export function defaultNodeData(type: CanvasNodeType): NodeData {
  switch (type) {
    case "textInput":
      return { kind: "textInput", label: "Text", value: "" };
    case "imageInput":
      return { kind: "imageInput", label: "Image" };
    case "videoInput":
      return { kind: "videoInput", label: "Video" };
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
