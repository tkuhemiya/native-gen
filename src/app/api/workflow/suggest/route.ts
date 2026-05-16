import { NextResponse } from "next/server";
import { z } from "zod";

import { buildTemplateWorkflowDocument } from "@/lib/workflow/template-from-brief";

const bodySchema = z.object({
  brief: z.string().min(1).max(4000),
});

/** Template expander — same graph as /api/workflow/agent without OpenAI. */
export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const workflow = buildTemplateWorkflowDocument(parsed.data.brief.trim());
    return NextResponse.json({
      workflow: {
        ...workflow,
        name: workflow.name.replace(/^Draft ·/, "AI draft ·"),
      },
    });
  } catch {
    return NextResponse.json({ error: "Generated workflow failed validation" }, { status: 500 });
  }
}
