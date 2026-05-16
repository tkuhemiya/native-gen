import { NextResponse } from "next/server";
import { z } from "zod";

import { buildTemplateWorkflowDocument } from "@/lib/workflow/template-from-brief";
import { workflowDocumentSchema } from "@/lib/workflow/schema";
import type { WorkflowDocument } from "@/lib/workflow/schema";
import { mergeComposerImagesIntoPrimaryMediaInput } from "@/lib/workflow/workflow-canvas-agent";
import {
  generateWorkflowWithOpenAI,
  workflowAgentLegacyUserContent,
  type WorkflowAgentDialogTurn,
} from "@/lib/workflow/workflow-agent";

const composerImageSchema = z.object({
  dataUrl: z.string().max(12 * 1024 * 1024),
  fileName: z.string().max(512).optional(),
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(6000),
});

const bodySchema = z
  .object({
    prompt: z.string().min(1).max(6000).optional(),
    messages: z.array(messageSchema).min(1).max(30).optional(),
    /** Images from the sidebar composer — merged into primary mediaInput after workflow apply. */
    composerImages: z.array(composerImageSchema).max(8).optional(),
    /** Current canvas so the agent can read/edit incrementally (full WorkflowDocument v3). */
    workflow: z.unknown().optional(),
    /** When true (OpenAI path only), respond with NDJSON stream + final `result` line. */
    stream: z.boolean().optional(),
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

  let canvasSnapshot: WorkflowDocument | null = null;
  const rawWorkflow = parsed.data.workflow;
  if (rawWorkflow !== undefined) {
    const checked = workflowDocumentSchema.safeParse(rawWorkflow);
    if (checked.success) canvasSnapshot = checked.data;
  }

  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (hasOpenAI && parsed.data.stream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        try {
          const result = await generateWorkflowWithOpenAI(dialog, {
            canvasSnapshot,
            streamSink: send,
            composerAttachments: parsed.data.composerImages,
          });
          send({
            type: "result",
            ...result,
            ...(result.validationRepaired
              ? { note: "Applied after the planner fixed validation details (you can ignore this)." }
              : {}),
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "OpenAI request failed";
          send({ type: "result", workflow: null, error: message });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (hasOpenAI) {
    let plannerAgentLog: string[] | undefined;
    try {
      const result = await generateWorkflowWithOpenAI(dialog, {
        canvasSnapshot,
        composerAttachments: parsed.data.composerImages,
      });
      plannerAgentLog = result.agentLog;
      if (result.workflow) {
        return NextResponse.json({
          workflow: result.workflow,
          source: "openai" as const,
          ...(plannerAgentLog?.length && { agentLog: plannerAgentLog }),
          ...(result.validationRepaired && {
            note: "Applied after the planner fixed validation details (you can ignore this).",
          }),
        });
      }
      return NextResponse.json(
        {
          error:
            result.validationError ??
            "The model could not produce a workflow that passes validation on the server.",
          ...(result.validationIssues?.length && { validationIssues: result.validationIssues }),
          ...(plannerAgentLog?.length && { agentLog: plannerAgentLog }),
        },
        { status: 422 },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "OpenAI request failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  let workflow = buildTemplateWorkflowDocument(templateBrief);
  workflow = mergeComposerImagesIntoPrimaryMediaInput(workflow, parsed.data.composerImages ?? []);
  return NextResponse.json({
    workflow,
    source: "template" as const,
    note: "Tip: add OPENAI_API_KEY to .env.local (restart the dev server) for AI-shaped graphs beyond this keyword matcher.",
  });
}
