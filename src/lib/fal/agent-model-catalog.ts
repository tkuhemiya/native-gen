import { getFalImageCaptionEndpointId } from "@/lib/fal/generation-models";
import { getFalTextToImageEndpointId } from "@/lib/fal/text-to-image-config";
import { getFalImageToVideoEndpointId } from "@/lib/fal/video-config";

export type FalModelCatalogEntry = {
  /** Generation intent / role in the workflow runner */
  intent: "text-to-image" | "image-to-text" | "image-to-video";
  label: string;
  /** Resolved fal queue id (env overrides applied) */
  endpointId: string;
  notes: string;
};

/**
 * Static catalog for the workflow agent — matches the server's configured endpoints.
 */
export function listFalModelCatalogForAgent(): FalModelCatalogEntry[] {
  return [
    {
      intent: "text-to-image",
      label: "Text → image (configured fal endpoint)",
      endpointId: getFalTextToImageEndpointId(),
      notes:
        "Text-only when no reference image pin. With a reference on the gen blue pin, the runner uses FAL_IMAGE_EDIT_MODEL (default openai/gpt-image-2/edit). Low/res via FAL_OPENAI_GPT_IMAGE_2_*.",
    },
    {
      intent: "image-to-text",
      label: "Image captioning",
      endpointId: getFalImageCaptionEndpointId(),
      notes: "Florence-style caption when a block outputs text from an image input.",
    },
    {
      intent: "image-to-video",
      label: "Image → video (animate a still)",
      endpointId: getFalImageToVideoEndpointId(),
      notes:
        "Used by the videoBlock node. Takes one image (https URL) plus a motion prompt and renders a short MP4 clip suitable for Reels / Shorts / TikTok / YouTube Shorts. Tunables: aspectRatio, resolution (720p or 1080p only — Wan API), durationSec integer **2–15** seconds (fal Wan v2.7 `duration`).",
    },
  ];
}
