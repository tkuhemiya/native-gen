import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import { z } from "zod";

export const WORKFLOW_DOCUMENT_VERSION = 5 as const;

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

/** Aspect presets the videoBlock supports (matches export targets). */
export const VIDEO_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

/** Output resolutions — Wan image-to-video accepts only these strings on fal. */
export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

/**
 * Wan v2.7 image-to-video (`fal-ai/wan/v2.7/image-to-video`): fal accepts integer `duration`
 * from **2 through 15** seconds per model docs.
 */
export const VIDEO_DURATION_SECONDS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;
export type VideoDurationSec = (typeof VIDEO_DURATION_SECONDS)[number];

export const VIDEO_DURATION_MIN_SEC = VIDEO_DURATION_SECONDS[0];
export const VIDEO_DURATION_MAX_SEC = VIDEO_DURATION_SECONDS[VIDEO_DURATION_SECONDS.length - 1];

export function clampVideoDurationSec(raw: unknown): VideoDurationSec {
  const fallback = 5 satisfies VideoDurationSec;
  const n =
    typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  const c = Math.min(VIDEO_DURATION_MAX_SEC, Math.max(VIDEO_DURATION_MIN_SEC, n));
  return c as VideoDurationSec;
}

export const nodeDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mediaInput"),
    label: z.string(),
    value: z.string(),
    images: z.array(mediaAssetSchema).default([]),
  }),
  z.object({
    kind: z.literal("generationBlock"),
    label: z.string(),
    /** Appended to upstream text prompts for image generation */
    suffix: z.string(),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
  }),
  z.object({
    kind: z.literal("videoBlock"),
    label: z.string(),
    /** Motion / camera / mood description appended to upstream text. */
    motionPrompt: z.string(),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    durationSec: z
      .number()
      .int()
      .min(VIDEO_DURATION_MIN_SEC)
      .max(VIDEO_DURATION_MAX_SEC),
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
  "generationBlock",
  "videoBlock",
  "platformExport",
] as const;

export type CanvasNodeType = (typeof NODE_TYPES)[number];

export function defaultNodeData(type: CanvasNodeType): NodeData {
  switch (type) {
    case "mediaInput":
      return {
        kind: "mediaInput",
        label: "Brief / posts",
        value: "",
        images: [],
      };
    case "generationBlock":
      return {
        kind: "generationBlock",
        label: "Generate",
        suffix: ", high quality ad creative, clean composition",
        imageSize: "landscape_4_3",
        numInferenceSteps: 2,
      };
    case "videoBlock":
      return {
        kind: "videoBlock",
        label: "Animate",
        motionPrompt:
          "smooth slow camera push-in, gentle parallax, subtle ambient motion, cinematic ad pacing",
        aspectRatio: "9:16",
        resolution: "720p",
        durationSec: 5,
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
