import type { FalFluxPresetSize } from "@/lib/fal/text-to-image-config";
import {
  isGptImageMiniEndpoint,
  isOpenAiGptImage2Endpoint,
  mapFluxPresetToGptImageMiniSize,
} from "@/lib/fal/text-to-image-config";

/**
 * USD estimates from fal.ai **Pricing** sections on each model page (re-fetch if bills drift).
 *
 * - flux/schnell: $0.003 / megapixel
 * - openai/gpt-image-2/edit: placeholder {@link FAL_OPENAI_GPT_IMAGE_2_EDIT_ESTIMATE_USD} — verify fal
 * - openai/gpt-image-2 (text-only): {@link FAL_OPENAI_GPT_IMAGE_2_LOW_ESTIMATE_USD}
 * - gpt-image-1-mini: medium tier ~$0.011 (1024²) / ~$0.015 (other sizes) per image + tokens — see model page
 * - florence-2-large/caption: listed as $0 per compute seconds — treated as $0 here
 */

export const FAL_FLUX_SCHNELL_USD_PER_MEGAPIXEL = 0.003;

/** Megapixels for fal Flux Schnell presets (matches FAL_FLUX_IMAGE_SIZE_DIMENSIONS pixel counts). */
export const FLUX_PRESET_MEGAPIXELS: Record<FalFluxPresetSize, number> = {
  landscape_16_9: (1024 * 576) / 1_000_000,
  portrait_16_9: (576 * 1024) / 1_000_000,
  square_hd: (1024 * 1024) / 1_000_000,
  square: (512 * 512) / 1_000_000,
  landscape_4_3: (1024 * 768) / 1_000_000,
  portrait_4_3: (768 * 1024) / 1_000_000,
};

export function falFluxSchnellImageUsd(imageSize: FalFluxPresetSize): number {
  return FLUX_PRESET_MEGAPIXELS[imageSize] * FAL_FLUX_SCHNELL_USD_PER_MEGAPIXEL;
}

/** Florence caption endpoint lists $0 / compute-second — no per-call dollar line item. */
export const FAL_FLORENCE_CAPTION_ESTIMATE_USD = 0;

export function falGptImageMiniImageUsd(imageSize: FalFluxPresetSize): number {
  const gpt = mapFluxPresetToGptImageMiniSize(imageSize);
  const is1024sq = gpt === "1024x1024";
  /** Medium-quality tier from fal pricing page (excluding prompt tokens). */
  return is1024sq ? 0.011 : 0.015;
}

/** Rough per-edit call for openai/gpt-image-2/edit @ low quality — verify on fal. */
export const FAL_OPENAI_GPT_IMAGE_2_EDIT_ESTIMATE_USD = 0.06;

/** Rough per-image floor for openai/gpt-image-2 @ low quality (excl. prompt tokens) — replace with fal table when stable. */
export const FAL_OPENAI_GPT_IMAGE_2_LOW_ESTIMATE_USD = 0.05;

/** Single text→image call estimate for the configured fal endpoint id. */
export function falTextToImageUsdForEndpoint(
  endpointId: string,
  imageSize: FalFluxPresetSize,
): number {
  if (isOpenAiGptImage2Endpoint(endpointId)) {
    void imageSize;
    return FAL_OPENAI_GPT_IMAGE_2_LOW_ESTIMATE_USD;
  }
  if (isGptImageMiniEndpoint(endpointId)) {
    return falGptImageMiniImageUsd(imageSize);
  }
  return falFluxSchnellImageUsd(imageSize);
}

export const FAL_PRICING_DISCLAIMER =
  "USD estimates from fal.ai model pages (openai/gpt-image-2/edit, openai/gpt-image-2, gpt-image-1-mini, flux/schnell, florence). Edit/text lines use placeholders; verify live pricing. Does not include retries, prompt tokens, discounts, or env overrides.";
