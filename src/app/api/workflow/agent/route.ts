import { NextResponse } from "next/server";
import { z } from "zod";

import { buildTemplateWorkflowDocument } from "@/lib/workflow/template-from-brief";
import { generateWorkflowWithOpenAI } from "@/lib/workflow/workflow-agent-openai";

const bodySchema = z.object({
  prompt: z.string().min(1).max(6000),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const prompt = parsed.data.prompt.trim();
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (hasOpenAI) {
    try {
      const fromModel = await generateWorkflowWithOpenAI(prompt);
      if (fromModel) {
        return NextResponse.json({ workflow: fromModel, source: "openai" as const });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "OpenAI request failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
    const fallback = buildTemplateWorkflowDocument(prompt);
    return NextResponse.json({
      workflow: fallback,
      source: "template" as const,
      note: "Model output did not validate; applied keyword template instead.",
    });
  }

  const workflow = buildTemplateWorkflowDocument(prompt);
  return NextResponse.json({
    workflow,
    source: "template" as const,
    note: "Set OPENAI_API_KEY for natural-language layouts beyond the keyword template.",
  });
}
