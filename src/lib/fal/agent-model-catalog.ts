import { getFalImageCaptionEndpointId } from "@/lib/fal/generation-models";
import { getFalTextToImageEndpointId } from "@/lib/fal/text-to-image-config";

export type FalModelCatalogEntry = {
  /** Generation intent / role in the workflow runner */
  intent: "text-to-image" | "image-to-text";
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
      label: "Text → image (FLUX Schnell class)",
      endpointId: getFalTextToImageEndpointId(),
      notes:
        "Used when a generation block outputs image from text only. Pricing on fal is often ~$0.003/MP for Schnell — verify on the model page.",
    },
    {
      intent: "image-to-text",
      label: "Image captioning",
      endpointId: getFalImageCaptionEndpointId(),
      notes: "Florence-style caption when a block outputs text from an image input.",
    },
  ];
}
