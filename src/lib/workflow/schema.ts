import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import { z } from "zod";

export const WORKFLOW_DOCUMENT_VERSION = 3 as const;

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
    kind: z.literal("generationBlock"),
    label: z.string(),
    /** Appended to upstream text prompts for diffusion / video models */
    suffix: z.string(),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
    /** fal-ai/veo3.1/lite duration tier */
    videoDuration: z.enum(["4s", "6s", "8s"]),
    videoResolution: z.enum(["720p", "1080p"]),
    /** When true, maps to `generate_audio: false` on Veo lite (usually cheapest). */
    videoSilent: z.boolean(),
    /** WAN image/video-to-video billed per second — minimum keeps demos cheap */
    wanDurationSec: z.number().int().min(2).max(15),
    wanResolution: z.enum(["720p", "1080p"]),
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

export const NODE_TYPES = ["mediaInput", "generationBlock", "platformExport"] as const;

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
    case "generationBlock":
      return {
        kind: "generationBlock",
        label: "Generate",
        suffix: ", high quality ad creative, clean composition",
        imageSize: "landscape_4_3",
        numInferenceSteps: 2,
        videoDuration: "4s",
        videoResolution: "720p",
        videoSilent: true,
        wanDurationSec: 2,
        wanResolution: "720p",
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
