import { ApiError, fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getFalImageCaptionEndpointId } from "@/lib/fal/generation-models";
import {
  logFalGenerationError,
  logFalGenerationRequest,
  logFalGenerationSuccess,
  summarizeMediaRef,
  summarizeMediaRefs,
  truncateForLog,
} from "@/lib/fal/generation-request-log";
import { resolveImageUrlForFal } from "@/lib/fal/resolve-image-url";
import {
  assertSafeFalEndpointId,
  buildOpenAiGptImage2EditQueueInput,
  buildTextToImageQueueInput,
  extractFalImagesUrl,
  falFluxPresetSizeSchema,
  getFalImageEditEndpointId,
  getFalTextToImageEndpointId,
  getFalTextToImageQueuePriority,
} from "@/lib/fal/text-to-image-config";
import {
  buildImageToVideoQueueInput,
  extractFalVideoUrl,
  getFalImageToVideoEndpointId,
} from "@/lib/fal/video-config";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATION_MAX_SEC,
  VIDEO_DURATION_MIN_SEC,
  VIDEO_RESOLUTIONS,
} from "@/lib/workflow/schema";

const logMetaSchema = {
  logNodeId: z.string().max(64).optional(),
  logLabel: z.string().max(200).optional(),
};

const bodySchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("text-to-image"),
    prompt: z.string().min(1).max(4000),
    imageSize: falFluxPresetSizeSchema,
    numInferenceSteps: z.number().min(1).max(12),
    ...logMetaSchema,
  }),
  z.object({
    intent: z.literal("image-to-image-edit"),
    prompt: z.string().min(1).max(4000),
    imageSize: falFluxPresetSizeSchema,
    imageUrls: z.array(z.string().min(10).max(25 * 1024 * 1024)).min(1).max(4),
    ...logMetaSchema,
  }),
  z.object({
    intent: z.literal("image-to-text"),
    /** https URL or data:image base64 (large refs uploaded to fal storage server-side). */
    imageUrl: z.string().min(10).max(25 * 1024 * 1024),
    ...logMetaSchema,
  }),
  z.object({
    intent: z.literal("image-to-video"),
    prompt: z.string().min(1).max(4000),
    imageUrl: z.string().min(10).max(25 * 1024 * 1024),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    durationSec: z.number().int().min(VIDEO_DURATION_MIN_SEC).max(VIDEO_DURATION_MAX_SEC),
    ...logMetaSchema,
  }),
]);

type LogMeta = { logNodeId?: string; logLabel?: string };

function extractLogMeta(payload: LogMeta): LogMeta {
  return {
    ...(payload.logNodeId ? { logNodeId: payload.logNodeId } : {}),
    ...(payload.logLabel ? { logLabel: payload.logLabel } : {}),
  };
}

function extractCaption(data: unknown): string | undefined {
  const r = (data as { results?: unknown }).results;
  return typeof r === "string" ? r : undefined;
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

/** Fal proxy for workflow runs: text→image + Florence captions (model from `FAL_TEXT_TO_IMAGE_MODEL`). */
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
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((i) =>
        [...i.path.map(String), i.message].filter(Boolean).join(": "),
      )
      .join("; ");
    return NextResponse.json(
      {
        error: detail ? `Invalid request — ${detail}` : "Invalid request body",
      },
      { status: 400 },
    );
  }

  const payload = parsed.data;
  const logMeta = extractLogMeta(payload);

  try {
    fal.config({ credentials: process.env.FAL_KEY });
    const priority = getFalTextToImageQueuePriority();

    switch (payload.intent) {
      case "text-to-image": {
        const endpointId = getFalTextToImageEndpointId();
        assertSafeFalEndpointId(endpointId);
        const input = buildTextToImageQueueInput(endpointId, {
          prompt: payload.prompt,
          imageSize: payload.imageSize,
          numInferenceSteps: payload.numInferenceSteps,
        });
        logFalGenerationRequest(
          payload.intent,
          {
            endpointId,
            queuePriority: priority,
            imageSize: payload.imageSize,
            numInferenceSteps: payload.numInferenceSteps,
            prompt: truncateForLog(payload.prompt),
            falInput: input,
          },
          logMeta,
        );
        const result = await fal.subscribe(endpointId, {
          input,
          logs: true,
          priority,
        });
        const url = extractFalImagesUrl(result.data);
        if (!url) {
          logFalGenerationError(payload.intent, "Fal did not return an image URL", logMeta);
          return NextResponse.json(
            { error: "Fal did not return an image URL" },
            { status: 502 },
          );
        }
        logFalGenerationSuccess(
          payload.intent,
          { endpointId, resultImage: summarizeMediaRef(url) },
          logMeta,
        );
        return NextResponse.json({ image: { url } });
      }
      case "image-to-image-edit": {
        const endpointId = getFalImageEditEndpointId();
        assertSafeFalEndpointId(endpointId);
        const hostedUrls = await Promise.all(
          payload.imageUrls.map((u) => resolveImageUrlForFal(u)),
        );
        const input = buildOpenAiGptImage2EditQueueInput({
          prompt: payload.prompt,
          imageSize: payload.imageSize,
          imageUrls: hostedUrls,
        });
        logFalGenerationRequest(
          payload.intent,
          {
            endpointId,
            queuePriority: priority,
            imageSize: payload.imageSize,
            prompt: truncateForLog(payload.prompt),
            referenceImages: summarizeMediaRefs(payload.imageUrls),
            hostedReferences: summarizeMediaRefs(hostedUrls),
            falInput: input,
          },
          logMeta,
        );
        const result = await fal.subscribe(endpointId, {
          input,
          logs: true,
          priority,
        });
        const url = extractFalImagesUrl(result.data);
        if (!url) {
          logFalGenerationError(payload.intent, "Fal did not return an image URL", logMeta);
          return NextResponse.json(
            { error: "Fal did not return an image URL" },
            { status: 502 },
          );
        }
        logFalGenerationSuccess(
          payload.intent,
          { endpointId, resultImage: summarizeMediaRef(url) },
          logMeta,
        );
        return NextResponse.json({ image: { url } });
      }
      case "image-to-text": {
        const endpointId = getFalImageCaptionEndpointId();
        assertSafeFalEndpointId(endpointId);
        logFalGenerationRequest(
          payload.intent,
          {
            endpointId,
            queuePriority: priority,
            image: summarizeMediaRef(payload.imageUrl),
          },
          logMeta,
        );
        const hostedUrl = await resolveImageUrlForFal(payload.imageUrl);
        const result = await fal.subscribe(endpointId, {
          input: { image_url: hostedUrl },
          logs: true,
          priority,
        });
        const caption = extractCaption(result.data)?.trim();
        if (!caption) {
          logFalGenerationError(payload.intent, "Fal did not return caption text", logMeta);
          return NextResponse.json(
            { error: "Fal did not return caption text" },
            { status: 502 },
          );
        }
        logFalGenerationSuccess(
          payload.intent,
          {
            endpointId,
            captionPreview: truncateForLog(caption, 280),
            captionLength: caption.length,
          },
          logMeta,
        );
        return NextResponse.json({ text: caption });
      }
      case "image-to-video": {
        const endpointId = getFalImageToVideoEndpointId();
        assertSafeFalEndpointId(endpointId);
        const hostedUrl = await resolveImageUrlForFal(payload.imageUrl);
        const input = buildImageToVideoQueueInput(endpointId, {
          imageUrl: hostedUrl,
          prompt: payload.prompt,
          aspectRatio: payload.aspectRatio,
          resolution: payload.resolution,
          durationSec: payload.durationSec,
        });
        logFalGenerationRequest(
          payload.intent,
          {
            endpointId,
            aspectRatio: payload.aspectRatio,
            resolution: payload.resolution,
            durationSec: payload.durationSec,
            prompt: truncateForLog(payload.prompt),
            sourceImage: summarizeMediaRef(payload.imageUrl),
            hostedSourceImage: summarizeMediaRef(hostedUrl),
            falInput: input,
          },
          logMeta,
        );
        const result = await fal.subscribe(endpointId, {
          input,
          logs: true,
          priority,
        });
        const url = extractFalVideoUrl(result.data);
        if (!url) {
          logFalGenerationError(payload.intent, "Fal did not return a video URL", logMeta);
          return NextResponse.json(
            { error: "Fal did not return a video URL" },
            { status: 502 },
          );
        }
        logFalGenerationSuccess(
          payload.intent,
          { endpointId, resultVideo: summarizeMediaRef(url) },
          logMeta,
        );
        return NextResponse.json({ video: { url } });
      }
      default: {
        const _never: never = payload;
        return _never;
      }
    }
  } catch (e) {
    const message = formatFalClientError(e);
    logFalGenerationError(payload.intent, message, logMeta);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
