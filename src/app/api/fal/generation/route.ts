import { fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getFalImageCaptionEndpointId,
  getFalImageToVideoEndpointId,
  getFalTextToVideoEndpointId,
} from "@/lib/fal/generation-models";
import {
  assertSafeFalEndpointId,
  buildFluxSchnellQueueInput,
  extractFalImagesUrl,
  falFluxPresetSizeSchema,
  getFalTextToImageEndpointId,
  getFalTextToImageQueuePriority,
} from "@/lib/fal/text-to-image-config";

const bodySchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("text-to-image"),
    prompt: z.string().min(1).max(4000),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
  }),
  z.object({
    intent: z.literal("text-to-video"),
    prompt: z.string().min(1).max(8000),
    duration: z.enum(["4s", "6s", "8s"]),
    resolution: z.enum(["720p", "1080p"]),
    silent: z.boolean(),
    aspectRatio: z.enum(["16:9", "9:16"]),
  }),
  z.object({
    intent: z.literal("image-to-video"),
    imageUrl: z.string().min(10).max(500_000),
    prompt: z.string().max(5000).optional(),
    durationSec: z.number().int().min(2).max(15),
    resolution: z.enum(["720p", "1080p"]),
  }),
  z.object({
    intent: z.literal("video-to-video"),
    videoUrl: z.string().min(10).max(500_000),
    prompt: z.string().max(5000).optional(),
    durationSec: z.number().int().min(2).max(15),
    resolution: z.enum(["720p", "1080p"]),
  }),
  z.object({
    intent: z.literal("image-to-text"),
    imageUrl: z.string().min(10).max(500_000),
  }),
]);

function extractVideoUrl(data: unknown): string | undefined {
  const v = (data as { video?: { url?: string } }).video?.url;
  return typeof v === "string" ? v : undefined;
}

function extractCaption(data: unknown): string | undefined {
  const r = (data as { results?: unknown }).results;
  return typeof r === "string" ? r : undefined;
}

/**
 * Unified fal proxy for workflow generation routing (text/image/video crosses).
 * Defaults favour inexpensive tiers (Flux Schnell, Veo 3.1 Lite silent 720p, WAN shortest duration).
 */
export async function POST(req: Request) {
  if (!process.env.FAL_KEY) {
    return NextResponse.json(
      { error: "FAL_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const payload = parsed.data;

  try {
    fal.config({ credentials: process.env.FAL_KEY });
    const priority = getFalTextToImageQueuePriority();

    switch (payload.intent) {
      case "text-to-image": {
        const endpointId = getFalTextToImageEndpointId();
        assertSafeFalEndpointId(endpointId);
        const input = buildFluxSchnellQueueInput({
          prompt: payload.prompt,
          imageSize: payload.imageSize,
          numInferenceSteps: payload.numInferenceSteps,
        });
        const result = await fal.subscribe(endpointId, {
          input,
          logs: true,
          priority,
        });
        const url = extractFalImagesUrl(result.data);
        if (!url) {
          return NextResponse.json(
            { error: "Fal did not return an image URL" },
            { status: 502 },
          );
        }
        return NextResponse.json({ image: { url } });
      }
      case "text-to-video": {
        const endpointId = getFalTextToVideoEndpointId();
        assertSafeFalEndpointId(endpointId);
        let duration = payload.duration;
        let resolution = payload.resolution;
        if (resolution === "1080p" && duration !== "8s") {
          duration = "8s";
        }
        const result = await fal.subscribe(endpointId, {
          input: {
            prompt: payload.prompt,
            aspect_ratio: payload.aspectRatio,
            duration,
            resolution,
            generate_audio: !payload.silent,
            negative_prompt: null,
          },
          logs: true,
          priority,
        });
        const url = extractVideoUrl(result.data);
        if (!url) {
          return NextResponse.json(
            { error: "Fal did not return a video URL" },
            { status: 502 },
          );
        }
        return NextResponse.json({ video: { url } });
      }
      case "image-to-video":
      case "video-to-video": {
        const endpointId = getFalImageToVideoEndpointId();
        assertSafeFalEndpointId(endpointId);
        const base =
          payload.intent === "image-to-video"
            ? {
                image_url: payload.imageUrl,
                video_url: null,
                prompt: payload.prompt ?? null,
              }
            : {
                image_url: null,
                video_url: payload.videoUrl,
                prompt: payload.prompt ?? null,
              };
        const result = await fal.subscribe(endpointId, {
          input: {
            ...base,
            resolution: payload.resolution,
            duration: payload.durationSec,
            enable_prompt_expansion: true,
            enable_safety_checker: true,
          },
          logs: true,
          priority,
        });
        const url = extractVideoUrl(result.data);
        if (!url) {
          return NextResponse.json(
            { error: "Fal did not return a video URL" },
            { status: 502 },
          );
        }
        return NextResponse.json({ video: { url } });
      }
      case "image-to-text": {
        const endpointId = getFalImageCaptionEndpointId();
        assertSafeFalEndpointId(endpointId);
        const result = await fal.subscribe(endpointId, {
          input: { image_url: payload.imageUrl },
          logs: true,
          priority,
        });
        const caption = extractCaption(result.data)?.trim();
        if (!caption) {
          return NextResponse.json(
            { error: "Fal did not return caption text" },
            { status: 502 },
          );
        }
        return NextResponse.json({ text: caption });
      }
      default: {
        const _never: never = payload;
        return _never;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fal request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
