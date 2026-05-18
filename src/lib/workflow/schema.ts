import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import { z } from "zod";

export const WORKFLOW_DOCUMENT_VERSION = 6 as const;

const mediaAssetSchema = z.object({
  dataUrl: z.string(),
  fileName: z.string().optional(),
});

export type StoredImageAsset = z.infer<typeof mediaAssetSchema>;
/** @deprecated name — composer still uses “media” language; wraps a single hosted data URL. */
export type MediaInputAsset = StoredImageAsset;

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

const sceneJoinTransitionSchema = z.object({
  mode: z.enum(["cut", "bridge"]),
  bridgePrompt: z.string().optional(),
});

export const nodeDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("textPrimitive"),
    label: z.string(),
    /** UX tag only (lore vs beat vs outline); does not change runner semantics. */
    purpose: z.string(),
    /** Saved authoring intent blended into downstream prompts when wired out. */
    prompt: z.string(),
    /** Primary body copy / script fragment on this primitive. */
    value: z.string(),
    locked: z.boolean(),
  }),
  z.object({
    kind: z.literal("imagePrimitive"),
    label: z.string(),
    /** Prompt / intent describing what belongs in this still (fed into generators upstream). */
    prompt: z.string(),
    /** Optional local photo — otherwise rely on upstream image wires after generation. */
    image: mediaAssetSchema.optional(),
    locked: z.boolean(),
  }),
  z.object({
    kind: z.literal("sceneCompose"),
    label: z.string(),
    locked: z.boolean(),
  }),
  z.object({
    kind: z.literal("sceneJoin"),
    label: z.string(),
    /** Ordered clip producers (`videoBlock` ids). Duplicates allowed. */
    orderedClipNodeIds: z.array(z.string()),
    /** Length should be `orderedClipNodeIds.length - 1`; padded with `cut` when shorter. */
    transitions: z.array(sceneJoinTransitionSchema),
  }),
  z.object({
    kind: z.literal("generationBlock"),
    label: z.string(),
    suffix: z.string(),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
    locked: z.boolean(),
  }),
  z.object({
    kind: z.literal("videoBlock"),
    label: z.string(),
    motionPrompt: z.string(),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    durationSec: z
      .number()
      .int()
      .min(VIDEO_DURATION_MIN_SEC)
      .max(VIDEO_DURATION_MAX_SEC),
    locked: z.boolean(),
  }),
  z.object({
    kind: z.literal("outputBlock"),
    label: z.string(),
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
  "textPrimitive",
  "imagePrimitive",
  "sceneCompose",
  "sceneJoin",
  "generationBlock",
  "videoBlock",
  "outputBlock",
] as const;

export type CanvasNodeType = (typeof NODE_TYPES)[number];

export function defaultNodeData(type: CanvasNodeType): NodeData {
  switch (type) {
    case "textPrimitive":
      return {
        kind: "textPrimitive",
        label: "Text",
        purpose: "",
        prompt: "",
        value: "",
        locked: false,
      };
    case "imagePrimitive":
      return {
        kind: "imagePrimitive",
        label: "Image",
        prompt: "",
        locked: false,
      };
    case "sceneCompose":
      return {
        kind: "sceneCompose",
        label: "Scene",
        locked: false,
      };
    case "sceneJoin":
      return {
        kind: "sceneJoin",
        label: "Join scenes",
        orderedClipNodeIds: [],
        transitions: [],
      };
    case "generationBlock":
      return {
        kind: "generationBlock",
        label: "Generate still",
        suffix:
          "cinematic short-story frame, cohesive lighting, readable silhouette, emotionally grounded composition",
        imageSize: "portrait_16_9",
        numInferenceSteps: 2,
        locked: false,
      };
    case "videoBlock":
      return {
        kind: "videoBlock",
        label: "Animate clip",
        motionPrompt:
          "subtle cinematic motion, gentle camera drift, continuity-friendly motion for stitching",
        aspectRatio: "9:16",
        resolution: "720p",
        durationSec: 5,
        locked: false,
      };
    case "outputBlock":
      return {
        kind: "outputBlock",
        label: "Preview · export",
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
