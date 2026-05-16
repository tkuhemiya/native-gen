/** Defaults: flux/schnell, veo3.1/lite, wan i2v — USD estimates in `fal-model-pricing.ts`. */

export const DEFAULT_FAL_TEXT_TO_VIDEO_MODEL = "fal-ai/veo3.1/lite";
export const DEFAULT_FAL_IMAGE_VIDEO_MODEL = "fal-ai/wan/v2.7/image-to-video";
export const DEFAULT_FAL_IMAGE_CAPTION_MODEL = "fal-ai/florence-2-large/caption";

export function getFalTextToVideoEndpointId(): string {
  return process.env.FAL_TEXT_TO_VIDEO_MODEL?.trim() || DEFAULT_FAL_TEXT_TO_VIDEO_MODEL;
}

export function getFalImageToVideoEndpointId(): string {
  return process.env.FAL_IMAGE_TO_VIDEO_MODEL?.trim() || DEFAULT_FAL_IMAGE_VIDEO_MODEL;
}

export function getFalImageCaptionEndpointId(): string {
  return process.env.FAL_IMAGE_CAPTION_MODEL?.trim() || DEFAULT_FAL_IMAGE_CAPTION_MODEL;
}
