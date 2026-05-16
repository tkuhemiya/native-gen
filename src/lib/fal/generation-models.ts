/** Defaults for fal-powered image workflows (captions via Florence). */

export const DEFAULT_FAL_IMAGE_CAPTION_MODEL = "fal-ai/florence-2-large/caption";

export function getFalImageCaptionEndpointId(): string {
  return process.env.FAL_IMAGE_CAPTION_MODEL?.trim() || DEFAULT_FAL_IMAGE_CAPTION_MODEL;
}
