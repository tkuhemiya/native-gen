import { fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  logFalGenerationError,
  logFalGenerationRequest,
  logFalGenerationSuccess,
  summarizeMediaRef,
  truncateForLog,
} from "@/lib/fal/generation-request-log";
import {
  assertSafeFalEndpointId,
  buildTextToImageQueueInput,
  extractFalImagesUrl,
  falFluxPresetSizeSchema,
  getFalTextToImageEndpointId,
  getFalTextToImageQueuePriority,
} from "@/lib/fal/text-to-image-config";

const bodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  imageSize: falFluxPresetSizeSchema.default("landscape_4_3"),
  numInferenceSteps: z.number().min(1).max(12).default(2),
});

/**
 * Text → image via fal; payload shape depends on `getFalTextToImageEndpointId()` / `FAL_TEXT_TO_IMAGE_MODEL`.
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

    const priority = getFalTextToImageQueuePriority();
    const input = buildTextToImageQueueInput(endpointId, {
      prompt,
      imageSize,
      numInferenceSteps,
    });

    logFalGenerationRequest("text-to-image", {
      endpointId,
      queuePriority: priority,
      imageSize,
      numInferenceSteps,
      prompt: truncateForLog(prompt),
      falInput: input,
    });

    const result = await fal.subscribe(endpointId, {
      input,
      logs: true,
      priority,
    });

    const url = extractFalImagesUrl(result.data);
    if (!url) {
      logFalGenerationError("text-to-image", "Fal did not return an image URL");
      return NextResponse.json({ error: "Fal did not return an image URL" }, { status: 502 });
    }

    logFalGenerationSuccess("text-to-image", {
      endpointId,
      resultImage: summarizeMediaRef(url),
    });

    return NextResponse.json({ image: { url } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fal request failed";
    logFalGenerationError("text-to-image", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
