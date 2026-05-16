import { fal } from "@fal-ai/client";
import { NextResponse } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  imageSize: z
    .enum(["square_hd", "landscape_4_3", "portrait_4_3"])
    .default("landscape_4_3"),
  numInferenceSteps: z.number().min(1).max(12).default(4),
});

/** Fal `flux/schnell` — fast, budget-friendly generations for demos. */
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

  try {
    fal.config({ credentials: process.env.FAL_KEY });
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt,
        image_size: imageSize,
        num_inference_steps: numInferenceSteps,
        num_images: 1,
        enable_safety_checker: true,
      },
      logs: true,
    });

    const images = (result.data as { images?: { url: string }[] }).images;
    const url = images?.[0]?.url;
    if (!url) {
      return NextResponse.json({ error: "Fal did not return an image URL" }, { status: 502 });
    }

    return NextResponse.json({ image: { url } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Fal request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
