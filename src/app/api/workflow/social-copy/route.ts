import { NextResponse } from "next/server";
import { z } from "zod";

import { generateMarketingSocialCopy } from "@/lib/workflow/social-marketing-copy";

const bodySchema = z.object({
  campaignBrief: z.string().max(8000),
  productDescription: z.string().max(8000).optional(),
  sceneBrief: z.string().max(8000).optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const text = await generateMarketingSocialCopy(parsed.data);
    return NextResponse.json({ text });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Social copy failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
