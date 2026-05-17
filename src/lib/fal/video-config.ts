import type { VideoAspectRatio, VideoResolution } from "@/lib/workflow/schema";

/**
 * Fal image→video for the workflow `videoBlock` node (`/api/fal/generation` `image-to-video`).
 *
 * Default model is **`fal-ai/wan/v2.7/image-to-video`**. Override with `FAL_IMAGE_TO_VIDEO_MODEL`.
 */

export const DEFAULT_FAL_IMAGE_TO_VIDEO_MODEL = "fal-ai/wan/v2.7/image-to-video";

export function getFalImageToVideoEndpointId(): string {
  return process.env.FAL_IMAGE_TO_VIDEO_MODEL?.trim() || DEFAULT_FAL_IMAGE_TO_VIDEO_MODEL;
}

/** Substring match so forks like `fal-ai/wan/v2.7/image-to-video/turbo` still route. */
export function isWanImageToVideoEndpoint(endpointId: string): boolean {
  return (
    endpointId.toLowerCase().includes("wan") &&
    endpointId.toLowerCase().includes("image-to-video")
  );
}

/** Wan **v2.7** queue uses integer `duration` (2–15s), not `num_frames`. */
export function isWanV27ImageToVideoEndpoint(endpointId: string): boolean {
  const id = endpointId.toLowerCase();
  return (
    id.includes("wan") &&
    id.includes("image-to-video") &&
    (id.includes("v2.7") || id.includes("/2.7/"))
  );
}

/**
 * Older Wan i2v queues take `num_frames` (typically 17–161). Approximate seconds × 16 fps + 1,
 * clamped to that range — used only when the endpoint is Wan i2v but **not** v2.7.
 */
export function wanLegacyNumFramesForDuration(seconds: number): number {
  const approx = Math.round(seconds * 16) + 1;
  return Math.min(161, Math.max(17, approx));
}

/**
 * Build the queue input for a fal image→video call.
 *
 * - **Wan v2.7**: `duration` (seconds), `resolution`, optional `aspect_ratio`, etc.
 * - **Other Wan i2v**: `num_frames` heuristic (legacy).
 * - **Else**: pass `duration` and hope the endpoint accepts it.
 */
export function buildImageToVideoQueueInput(
  endpointId: string,
  payload: {
    imageUrl: string;
    prompt: string;
    aspectRatio: VideoAspectRatio;
    resolution: VideoResolution;
    durationSec: number;
  },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    image_url: payload.imageUrl,
    prompt: payload.prompt,
    aspect_ratio: payload.aspectRatio,
    resolution: payload.resolution,
  };
  if (isWanV27ImageToVideoEndpoint(endpointId)) {
    base.duration = payload.durationSec;
  } else if (isWanImageToVideoEndpoint(endpointId)) {
    base.num_frames = wanLegacyNumFramesForDuration(payload.durationSec);
  } else {
    base.duration = payload.durationSec;
  }
  return base;
}

/** Pull the rendered MP4 URL out of a fal i2v queue result. */
export function extractFalVideoUrl(resultData: unknown): string | undefined {
  const v = (resultData as { video?: { url?: string } | { url?: string }[] }).video;
  if (Array.isArray(v)) {
    const url = v[0]?.url;
    return typeof url === "string" ? url : undefined;
  }
  if (v && typeof v === "object") {
    const url = (v as { url?: string }).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}
