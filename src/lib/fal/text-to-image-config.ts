import { z } from "zod";

/**
 * Fal text→image for workflow generation blocks (`/api/fal/generation`, `/api/fal/text-to-image`).
 *
 * Default model is **`openai/gpt-image-2`** (low quality + smaller presets — see mappers below).
 * Override with `FAL_TEXT_TO_IMAGE_MODEL` (e.g. `fal-ai/flux/schnell`) — see `buildTextToImageQueueInput`.
 */

/** Default fal queue model for text→image (override with `FAL_TEXT_TO_IMAGE_MODEL`). */
export const DEFAULT_FAL_TEXT_TO_IMAGE_MODEL = "openai/gpt-image-2";

/** Fal-hosted OpenAI GPT Image 2 text→image (`openai/gpt-image-2`); not the `/edit` endpoint. */
export function isOpenAiGptImage2Endpoint(endpointId: string): boolean {
  const id = endpointId.trim();
  return id.includes("gpt-image-2") && !id.includes("/edit");
}

/** Substring match so forks like `fal-ai/gpt-image-1-mini/foo` still route correctly. */
export function isGptImageMiniEndpoint(endpointId: string): boolean {
  return endpointId.includes("gpt-image-1-mini");
}

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

/** GPT Image Mini `image_size` enum (camelCase string tokens per fal API). */
export type GptImageMiniPixelSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";

/** Map workflow aspect presets to GPT Image Mini sizes (closest aspect bucket). */
export function mapFluxPresetToGptImageMiniSize(preset: FalFluxPresetSize): GptImageMiniPixelSize {
  switch (preset) {
    case "landscape_16_9":
    case "landscape_4_3":
      return "1536x1024";
    case "portrait_16_9":
    case "portrait_4_3":
      return "1024x1536";
    case "square_hd":
    case "square":
      return "1024x1024";
    default: {
      const _ex: never = preset;
      return _ex;
    }
  }
}

export type GptImageMiniQuality = "auto" | "low" | "medium" | "high";

function getFalGptImageQuality(): GptImageMiniQuality {
  const raw = process.env.FAL_GPT_IMAGE_QUALITY?.trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "auto") return raw;
  return "auto";
}

export type GptImageMiniOutputFormat = "jpeg" | "png" | "webp";

/** Output format for GPT Image Mini (`FAL_GPT_IMAGE_OUTPUT_FORMAT`, default jpeg). */
export function getFalGptImageOutputFormat(): GptImageMiniOutputFormat {
  const raw = process.env.FAL_GPT_IMAGE_OUTPUT_FORMAT?.trim().toLowerCase();
  if (raw === "png" || raw === "webp") return raw;
  return "jpeg";
}

/** fal-ai/gpt-image-1-mini queue input (camelCase keys in JSON per OpenAPI). */
export function buildGptImageMiniQueueInput(payload: {
  prompt: string;
  imageSize: FalFluxPresetSize;
}): Record<string, unknown> {
  return {
    prompt: payload.prompt,
    image_size: mapFluxPresetToGptImageMiniSize(payload.imageSize),
    background: "auto",
    quality: getFalGptImageQuality(),
    num_images: 1,
    output_format: getFalGptImageOutputFormat(),
  };
}

/**
 * Shrink workflow presets toward fewer pixels for openai/gpt-image-2 (`square_hd` → `square`, etc.).
 */
export function mapFluxPresetToOpenAiGptImage2LowResPreset(
  preset: FalFluxPresetSize,
): FalFluxPresetSize {
  switch (preset) {
    case "square_hd":
      return "square";
    case "landscape_4_3":
      return "landscape_16_9";
    case "portrait_4_3":
      return "portrait_16_9";
    default:
      return preset;
  }
}

export type OpenAiGptImage2Quality = "auto" | "low" | "medium" | "high";

/** Default `low`; override with `FAL_OPENAI_GPT_IMAGE_2_QUALITY`. */
export function getOpenAiGptImage2Quality(): OpenAiGptImage2Quality {
  const raw = process.env.FAL_OPENAI_GPT_IMAGE_2_QUALITY?.trim().toLowerCase();
  if (raw === "auto" || raw === "low" || raw === "medium" || raw === "high") return raw;
  return "low";
}

export type OpenAiGptImage2OutputFormat = "jpeg" | "png" | "webp";

/** Default jpeg; override `FAL_OPENAI_GPT_IMAGE_2_OUTPUT_FORMAT`. */
export function getOpenAiGptImage2OutputFormat(): OpenAiGptImage2OutputFormat {
  const raw = process.env.FAL_OPENAI_GPT_IMAGE_2_OUTPUT_FORMAT?.trim().toLowerCase();
  if (raw === "png" || raw === "webp") return raw;
  return "jpeg";
}

/** openai/gpt-image-2 queue input (same preset enum names as Flux on fal). */
export function buildOpenAiGptImage2QueueInput(payload: {
  prompt: string;
  imageSize: FalFluxPresetSize;
}): Record<string, unknown> {
  return {
    prompt: payload.prompt,
    image_size: mapFluxPresetToOpenAiGptImage2LowResPreset(payload.imageSize),
    quality: getOpenAiGptImage2Quality(),
    num_images: 1,
    output_format: getOpenAiGptImage2OutputFormat(),
  };
}

/** Image + prompt edits (`openai/gpt-image-2/edit`); override with `FAL_IMAGE_EDIT_MODEL`. */
export function getFalImageEditEndpointId(): string {
  return process.env.FAL_IMAGE_EDIT_MODEL?.trim() || "openai/gpt-image-2/edit";
}

/** openai/gpt-image-2/edit — reference URLs must be https or uploaded via {@link resolveImageUrlForFal}. */
export function buildOpenAiGptImage2EditQueueInput(payload: {
  prompt: string;
  imageSize: FalFluxPresetSize;
  imageUrls: string[];
}): Record<string, unknown> {
  return {
    prompt: payload.prompt,
    image_urls: payload.imageUrls,
    image_size: mapFluxPresetToOpenAiGptImage2LowResPreset(payload.imageSize),
    quality: getOpenAiGptImage2Quality(),
    num_images: 1,
    output_format: getOpenAiGptImage2OutputFormat(),
  };
}

/** Build the correct `input` object for whichever text→image endpoint is configured. */
export function buildTextToImageQueueInput(
  endpointId: string,
  payload: {
    prompt: string;
    imageSize: FalFluxPresetSize;
    numInferenceSteps: number;
  },
): Record<string, unknown> {
  if (isOpenAiGptImage2Endpoint(endpointId)) {
    return buildOpenAiGptImage2QueueInput({
      prompt: payload.prompt,
      imageSize: payload.imageSize,
    });
  }
  if (isGptImageMiniEndpoint(endpointId)) {
    return buildGptImageMiniQueueInput({
      prompt: payload.prompt,
      imageSize: payload.imageSize,
    });
  }
  return buildFluxSchnellQueueInput(payload);
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
