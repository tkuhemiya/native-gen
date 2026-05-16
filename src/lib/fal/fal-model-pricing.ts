import type { FalFluxPresetSize } from "@/lib/fal/text-to-image-config";

/**
 * USD estimates from fal.ai **Pricing** sections on each model page (re-fetch if bills drift).
 *
 * - flux/schnell: $0.003 / megapixel
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

export const FAL_PRICING_DISCLAIMER =
  "USD estimates from fal.ai model pages (flux/schnell, florence-2-large/caption). Does not include retries, account discounts, or different models set via FAL_* env vars.";
