import type { FalFluxPresetSize } from "@/lib/fal/text-to-image-config";

/**
 * USD estimates from fal.ai **Pricing** sections on each model page (re-fetch if bills drift).
 *
 * - flux/schnell: $0.003 / megapixel
 * - veo3.1/lite: per second by resolution + audio
 * - wan/v2.7/image-to-video: $0.10/s (720p), $0.15/s (1080p)
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

/** Veo 3.1 Lite — per-second rates from https://fal.ai/models/fal-ai/veo3.1/lite */
export function falVeo31LiteUsdPerSecond(opts: {
  resolution: "720p" | "1080p";
  withAudio: boolean;
}): number {
  if (opts.resolution === "720p") {
    return opts.withAudio ? 0.05 : 0.03;
  }
  return opts.withAudio ? 0.08 : 0.05;
}

/**
 * Mirrors `src/app/api/fal/generation/route.ts`: 1080p forces 8s duration for billing.
 */
export function effectiveVeoDurationSecondsForBilling(
  duration: "4s" | "6s" | "8s",
  resolution: "720p" | "1080p",
): 4 | 6 | 8 {
  if (resolution === "1080p" && duration !== "8s") return 8;
  if (duration === "4s") return 4;
  if (duration === "6s") return 6;
  return 8;
}

export function falVeo31LiteRunUsd(opts: {
  duration: "4s" | "6s" | "8s";
  resolution: "720p" | "1080p";
  videoSilent: boolean;
}): number {
  const seconds = effectiveVeoDurationSecondsForBilling(opts.duration, opts.resolution);
  const perSec = falVeo31LiteUsdPerSecond({
    resolution: opts.resolution,
    withAudio: !opts.videoSilent,
  });
  return perSec * seconds;
}

/** WAN 2.7 image/video-to-video — https://fal.ai/models/fal-ai/wan/v2.7/image-to-video */
export function falWan27VideoUsdPerSecond(resolution: "720p" | "1080p"): number {
  return resolution === "720p" ? 0.1 : 0.15;
}

export function falWan27RunUsd(durationSec: number, resolution: "720p" | "1080p"): number {
  return falWan27VideoUsdPerSecond(resolution) * durationSec;
}

/** Florence caption endpoint lists $0 / compute-second — no per-call dollar line item. */
export const FAL_FLORENCE_CAPTION_ESTIMATE_USD = 0;

export const FAL_PRICING_DISCLAIMER =
  "USD estimates from fal.ai model pages (flux/schnell, veo3.1/lite, wan/v2.7/image-to-video, florence-2-large/caption). Does not include retries, account discounts, or different models set via FAL_* env vars.";
