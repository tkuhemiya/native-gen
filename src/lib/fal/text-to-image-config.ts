import { z } from "zod";

/**
 * Fal text→image (workflow Flux node → POST `/api/fal/text-to-image`).
 *
 * **Billing:** Flux.1 [schnell] is **$0.003 per megapixel** on
 * https://fal.ai/models/fal-ai/flux/schnell — see `src/lib/fal/fal-model-pricing.ts` for estimates.
 */

/** Default fal queue model for our text→image route (cheapest Flux text→image tier we support). */
export const DEFAULT_FAL_TEXT_TO_IMAGE_MODEL = "fal-ai/flux/schnell";

/**
 * Named `image_size` values documented for fal-ai/flux/schnell (preset aspect ratios).
 * Custom `{ width, height }` is also supported by fal but not wired in this UI yet.
 */
export const FAL_FLUX_IMAGE_SIZES = [
  "landscape_16_9",
  "portrait_16_9",
  "square_hd",
  "square",
  "landscape_4_3",
  "portrait_4_3",
] as const;

export type FalFluxPresetSize = (typeof FAL_FLUX_IMAGE_SIZES)[number];

export const falFluxPresetSizeSchema = z.enum(FAL_FLUX_IMAGE_SIZES);

/** Short dropdown labels — full pixel presets are fal defaults; hover the field for sizes. */
export const FAL_FLUX_IMAGE_SIZE_LABELS = {
  landscape_16_9: "16:9 landscape",
  portrait_16_9: "9:16 portrait",
  square_hd: "1:1 HD",
  square: "1:1 (512²)",
  landscape_4_3: "4:3 landscape",
  portrait_4_3: "4:3 portrait",
} as const satisfies Record<FalFluxPresetSize, string>;

export const FAL_FLUX_IMAGE_SIZE_DIMENSIONS = {
  landscape_16_9: "1024×576 px (fal preset)",
  portrait_16_9: "576×1024 px (fal preset)",
  square_hd: "1024×1024 px (fal preset)",
  square: "512×512 px (fal preset)",
  landscape_4_3: "1024×768 px (fal preset)",
  portrait_4_3: "768×1024 px (fal preset)",
} as const satisfies Record<FalFluxPresetSize, string>;

export type FalFluxAcceleration = "none" | "regular" | "high";

export type FalFluxOutputFormat = "jpeg" | "png";

function truthyEnv(raw: string | undefined): boolean {
  const t = raw?.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

/** Fal queue priority: `low` is often fine for drafts (same per‑MP billing, slightly slower enqueue). */
export function getFalTextToImageQueuePriority(): "low" | "normal" {
  return truthyEnv(process.env.FAL_QUEUE_LOW_PRIORITY) ? "low" : "normal";
}

/** Flux Schnell acceleration (speed knobs; billed megapixels unchanged). Default `regular` balance. */
export function getFalFluxAcceleration(): FalFluxAcceleration {
  const raw = process.env.FAL_FLUX_ACCELERATION?.trim().toLowerCase();
  if (raw === "none" || raw === "regular" || raw === "high") return raw;
  return "regular";
}

/** Smaller payloads over the wire vs PNG; default jpeg. */
export function getFalFluxOutputFormat(): FalFluxOutputFormat {
  const raw = process.env.FAL_FLUX_OUTPUT_FORMAT?.trim().toLowerCase();
  if (raw === "png") return "png";
  return "jpeg";
}

/** Endpoint ID for fal.subscribe (override via `FAL_TEXT_TO_IMAGE_MODEL`). */
export function getFalTextToImageEndpointId(): string {
  return process.env.FAL_TEXT_TO_IMAGE_MODEL?.trim() || DEFAULT_FAL_TEXT_TO_IMAGE_MODEL;
}

/** Fal queue IDs are slash-separated (e.g. fal-ai/flux/schnell). Reject odd characters only. */
const ENDPOINT_SAFE =
  /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_.-]*)+$/i;

export function assertSafeFalEndpointId(endpointId: string): void {
  if (!ENDPOINT_SAFE.test(endpointId.trim())) {
    throw new Error("FAL_TEXT_TO_IMAGE_MODEL looks invalid (namespace/endpoint)");
  }
}

/** Input object for Flux Schnell / compatible queue endpoints (`image_size`, snake_case keys). */
export function buildFluxSchnellQueueInput(payload: {
  prompt: string;
  imageSize: FalFluxPresetSize;
  numInferenceSteps: number;
}): Record<string, unknown> {
  return {
    prompt: payload.prompt,
    image_size: payload.imageSize,
    num_inference_steps: payload.numInferenceSteps,
    num_images: 1,
    enable_safety_checker: true,
    output_format: getFalFluxOutputFormat(),
    acceleration: getFalFluxAcceleration(),
  };
}

export function extractFalImagesUrl(resultData: unknown): string | undefined {
  const images = (
    resultData as {
      images?: { url?: string }[];
    }
  ).images;
  const url = images?.[0]?.url;
  return typeof url === "string" ? url : undefined;
}
