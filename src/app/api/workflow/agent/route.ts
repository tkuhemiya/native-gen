import { NextResponse } from "next/server";
import { z } from "zod";

import { buildTemplateWorkflowDocument } from "@/lib/workflow/template-from-brief";
import {
  generateWorkflowWithOpenAI,
  workflowAgentLegacyUserContent,
  type WorkflowAgentDialogTurn,
} from "@/lib/workflow/workflow-agent-openai";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(6000),
});

const bodySchema = z
  .object({
    prompt: z.string().min(1).max(6000).optional(),
    messages: z.array(messageSchema).min(1).max(30).optional(),
  })
  .superRefine((data, ctx) => {
    const hasPrompt = Boolean(data.prompt?.trim());
    const hasMessages = Boolean(data.messages && data.messages.length > 0);
    if (!hasPrompt && !hasMessages) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Send prompt or messages" });
    }
    if (hasPrompt && hasMessages) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Send only one of prompt or messages" });
    }
    const msgs = data.messages;
    if (msgs && msgs.length) {
      const last = msgs[msgs.length - 1];
      if (last?.role !== "user") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The last chat message must be from the user",
        });
      }
    }
  });

function briefFromDialog(dialog: WorkflowAgentDialogTurn[]): string {
  const users = dialog.filter((t) => t.role === "user").map((t) => t.content.trim());
  return users.join("\n\n").trim().slice(0, 6000);
}

/** Build OpenAI-ready dialog + template brief from validated body */
function normalizedDialogAndBrief(
  data: z.infer<typeof bodySchema>,
): { dialog: WorkflowAgentDialogTurn[]; templateBrief: string } {
  if (data.prompt?.trim()) {
    const brief = data.prompt.trim();
    return {
      dialog: [{ role: "user" as const, content: workflowAgentLegacyUserContent(brief) }],
      templateBrief: brief,
    };
  }

  const raw = data.messages ?? [];
  const dialog: WorkflowAgentDialogTurn[] = raw.map((m) => ({
    role: m.role,
    content: m.content.trim(),
  }));
  return { dialog, templateBrief: briefFromDialog(dialog) };
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { dialog, templateBrief } = normalizedDialogAndBrief(parsed.data);

  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (hasOpenAI) {
    try {
      const fromModel = await generateWorkflowWithOpenAI(dialog);
      if (fromModel) {
        return NextResponse.json({ workflow: fromModel, source: "openai" as const });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "OpenAI request failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
    const fallback = buildTemplateWorkflowDocument(templateBrief);
    return NextResponse.json({
      workflow: fallback,
      source: "template" as const,
      note: "Model output did not validate; applied keyword template instead.",
    });
  }

  const workflow = buildTemplateWorkflowDocument(templateBrief);
  return NextResponse.json({
    workflow,
    source: "template" as const,
    note: "Optional: set OPENAI_API_KEY in .env.local (then restart `next dev`) so this chat can reason about free-form briefs instead of keyword templates.",
  });
}
