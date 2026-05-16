import { ApiError, fal } from "@fal-ai/client";
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

/** WAN rejects explicit nulls on unused optional fields; fal 422 surfaces as statusText-only errors. */
const WAN_FALLBACK_PROMPT =
  "Subtle cinematic motion, sharp detail, advertising polish";

function wanPromptFromOptional(prompt: string | undefined): string {
  const t = prompt?.trim();
  return t && t.length > 0 ? t : WAN_FALLBACK_PROMPT;
}

function formatFalClientError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string; detail?: unknown } | undefined;
    const msg = body?.message?.trim();
    if (msg) return msg;
    const detail = body?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const parts = detail.map((item: unknown) => {
        if (item && typeof item === "object" && "msg" in item) {
          const row = item as { msg?: string; loc?: unknown };
          const loc =
            Array.isArray(row.loc) ? row.loc.join(".") : String(row.loc ?? "");
          const m = row.msg?.trim() ?? "";
          return [loc, m].filter(Boolean).join(": ");
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      });
      const joined = parts.filter(Boolean).join("; ");
      if (joined) return joined;
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const o = detail as Record<string, unknown>;
      if (typeof o.message === "string" && o.message.trim()) {
        return o.message.trim();
      }
      if (typeof o.msg === "string" && o.msg.trim()) return o.msg.trim();
    }
  }
  return e instanceof Error ? e.message : "Fal request failed";
}

function buildWanMotionInput(
  intent: "image-to-video" | "video-to-video",
  payload: {
    imageUrl?: string;
    videoUrl?: string;
    prompt?: string | undefined;
    resolution: "720p" | "1080p";
    durationSec: number;
  },
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: wanPromptFromOptional(payload.prompt),
    resolution: payload.resolution,
    duration: payload.durationSec,
    enable_prompt_expansion: true,
    enable_safety_checker: true,
  };
  if (intent === "image-to-video") {
    input.image_url = payload.imageUrl;
  } else {
    input.video_url = payload.videoUrl;
  }
  return input;
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
        const wanInput =
          payload.intent === "image-to-video"
            ? buildWanMotionInput("image-to-video", {
                imageUrl: payload.imageUrl,
                prompt: payload.prompt,
                resolution: payload.resolution,
                durationSec: payload.durationSec,
              })
            : buildWanMotionInput("video-to-video", {
                videoUrl: payload.videoUrl,
                prompt: payload.prompt,
                resolution: payload.resolution,
                durationSec: payload.durationSec,
              });
        const result = await fal.subscribe(endpointId, {
          input: wanInput,
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
    const message = formatFalClientError(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
