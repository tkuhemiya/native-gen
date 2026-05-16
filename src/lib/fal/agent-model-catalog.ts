import {
  getFalImageCaptionEndpointId,
  getFalImageToVideoEndpointId,
  getFalTextToVideoEndpointId,
} from "@/lib/fal/generation-models";
import { getFalTextToImageEndpointId } from "@/lib/fal/text-to-image-config";

export type FalModelCatalogEntry = {
  /** Generation intent / role in the workflow runner */
  intent:
    | "text-to-image"
    | "text-to-video"
    | "image-to-video"
    | "video-to-video"
    | "image-to-text";
  label: string;
  /** Resolved fal queue id (env overrides applied) */
  endpointId: string;
  notes: string;
};

/**
 * Static catalog for the workflow agent — always matches the server's configured endpoints.
 */
export function listFalModelCatalogForAgent(): FalModelCatalogEntry[] {
  return [
    {
      intent: "text-to-image",
      label: "Text → image (FLUX Schnell class)",
      endpointId: getFalTextToImageEndpointId(),
      notes:
        "Used when a generation block outputs image from text only. Pricing on fal is often ~$0.003/MP for Schnell — verify on the model page.",
    },
    {
      intent: "text-to-video",
      label: "Text → video",
      endpointId: getFalTextToVideoEndpointId(),
      notes: "Used when output is video and only text is wired in. Duration/resolution affect cost.",
    },
    {
      intent: "image-to-video",
      label: "Image → video (WAN class)",
      endpointId: getFalImageToVideoEndpointId(),
      notes: "Used when a video output is driven from an upstream image (and optional prompt).",
    },
    {
      intent: "video-to-video",
      label: "Video → video continuation",
      endpointId: getFalImageToVideoEndpointId(),
      notes:
        "Runner uses the same fal route shape as image→video with a source video URL; endpoint id follows FAL_IMAGE_TO_VIDEO_MODEL unless you split this in the API.",
    },
    {
      intent: "image-to-text",
      label: "Image captioning",
      endpointId: getFalImageCaptionEndpointId(),
      notes: "Florence-style caption when a block outputs text from an image input.",
    },
  ];
}
