import { ApiError, fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getFalImageCaptionEndpointId } from "@/lib/fal/generation-models";
import { resolveImageUrlForFal } from "@/lib/fal/resolve-image-url";
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
    intent: z.literal("image-to-text"),
    /** https URL or data:image base64 (large refs uploaded to fal storage server-side). */
    imageUrl: z.string().min(10).max(25 * 1024 * 1024),
  }),
]);

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

/** Fal proxy for workflow runs: Flux image generation + Florence captions only. */
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
      case "image-to-text": {
        const endpointId = getFalImageCaptionEndpointId();
        assertSafeFalEndpointId(endpointId);
        const hostedUrl = await resolveImageUrlForFal(payload.imageUrl);
        const result = await fal.subscribe(endpointId, {
          input: { image_url: hostedUrl },
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
