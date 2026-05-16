/**
 * Fal text→image (workflow Flux node → POST `/api/fal/text-to-image`).
 *
 * Pricing (verify on fal): **FLUX.1 [schnell]** is billed about **$0.003/megapixel** on
 * https://fal.ai/models/fal-ai/flux/schnell — lower per MP than e.g. FLUX.2 Klein (~$0.009/MP) and
 * FLUX.2 [dev] (~$0.012/MP) per fal’s own comparison content. This app’s input shape matches Schnell;
 * other endpoints need a different payload.
 */

/** Default fal queue model for our text→image route (cheapest Flux text→image tier we support). */
export const DEFAULT_FAL_TEXT_TO_IMAGE_MODEL = "fal-ai/flux/schnell";

export type FalFluxPresetSize = "square_hd" | "landscape_4_3" | "portrait_4_3";

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

const ENDPOINT_SAFE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*$/i;

export function assertSafeFalEndpointId(endpointId: string): void {
  if (!ENDPOINT_SAFE.test(endpointId)) {
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
