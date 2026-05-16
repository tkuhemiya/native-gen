import { fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  assertSafeFalEndpointId,
  buildFluxSchnellQueueInput,
  extractFalImagesUrl,
  getFalTextToImageEndpointId,
  getFalTextToImageQueuePriority,
} from "@/lib/fal/text-to-image-config";

const bodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  imageSize: z
    .enum(["square_hd", "landscape_4_3", "portrait_4_3"])
    .default("landscape_4_3"),
  numInferenceSteps: z.number().min(1).max(12).default(2),
});

/**
 * Text → image via fal (workflow Flux node). Payload targets FLUX Schnell–compatible schemas;
 * defaults to **`fal-ai/flux/schnell`** (~$0.003/MP — check fal.ai for current tiers).
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

  const { prompt, imageSize, numInferenceSteps } = parsed.data;

  let endpointId: string;
  try {
    endpointId = getFalTextToImageEndpointId();
    assertSafeFalEndpointId(endpointId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid FAL_TEXT_TO_IMAGE_MODEL";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    fal.config({ credentials: process.env.FAL_KEY });

    const input = buildFluxSchnellQueueInput({
      prompt,
      imageSize,
      numInferenceSteps,
    });

    const result = await fal.subscribe(endpointId, {
      input,
      logs: true,
      priority: getFalTextToImageQueuePriority(),
    });

    const url = extractFalImagesUrl(result.data);
    if (!url) {
      return NextResponse.json({ error: "Fal did not return an image URL" }, { status: 502 });
    }

    return NextResponse.json({ image: { url } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fal request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
