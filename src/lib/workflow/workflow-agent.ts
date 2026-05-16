import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

import { buildYoutubeLookRefThenVideoTemplate } from "./template-from-brief";
import type { WorkflowDocument } from "./schema";
import { compileWorkflowPlanToDocument, workflowPlanSchema } from "./workflow-plan";

/** Plan JSON as a string keeps OpenAI tool schemas small; Zod runs in execute. */
const planJsonInputSchema = z.object({
  planJson: z
    .string()
    .min(4)
    .describe("Full workflow plan as a JSON string: version, name, stages (see system prompt)."),
});

const SYSTEM = `You build a workflow **plan** for our canvas (not raw graph JSON).

Stages are ordered left-to-right:
1) Exactly one mediaInput — use id "media" unless the user already used another id in thread; brief text is injected server-side.
2) Zero or more generation stages — label, suffix, outputs (text/image/video), optional inputs (target pin → fromStageId + pin).
3) One platformExport — platform, optional copyFromStageId, imageFromStageId, videoFromStageId.

**Tools (use them):**
- \`lint_workflow_plan\` — checks JSON + schema only; use if you need to fix structure.
- \`compile_workflow_plan\` — validates, compiles to a runnable document, **must** succeed for the user to get a workflow. Call when the plan is ready. If it returns success:false, read \`error\` and fix the plan, then compile again.

Finish by calling \`compile_workflow_plan\` with the full \`planJson\` string. If it returns success:false, fix the plan and call \`compile_workflow_plan\` again — do not stop until compilation succeeds or you exhaust the step budget.

Keep stage ids short ("media", "look", "motion", "out").`;

const DEFAULT_MODEL = "gpt-5.4-mini";

function parsePlanJson(planJson: string): { ok: true; plan: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, plan: JSON.parse(planJson) as unknown };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function formatZodIssues(error: z.ZodError, maxIssues = 24): string {
  return error.issues
    .slice(0, maxIssues)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

export type WorkflowAgentDialogTurn = {
  role: "user" | "assistant";
  content: string;
};

/** Strip wrapper used by legacy \`/api/workflow/agent\` body \`{ prompt }\`. */
function extractCampaignBriefFromDialog(dialog: WorkflowAgentDialogTurn[]): string {
  const users = dialog.filter((t) => t.role === "user").map((t) => t.content.trim());
  const raw = users.join("\n\n").trim();
  return raw
    .replace(/^Build a workflow for this campaign request:\s*\n+/im, "")
    .trim()
    .slice(0, 6000);
}

function briefSuggestsLookRefPipeline(brief: string): boolean {
  const lower = brief.toLowerCase();
  return (
    /\b(movie|movies|film|films|short film|filmmak\w*|trailer|reels?|cinematic|footage)\b/.test(
      lower,
    ) ||
    /\b(character|characters|protagonist|mascot|consistent|same (face|look|outfit))\b/.test(
      lower,
    ) ||
    /\b(story|narrative|scene|plot|tell a story)\b/.test(lower)
  );
}

function isSingleGenYoutubeVideoExport(doc: WorkflowDocument): boolean {
  const gens = doc.nodes.filter((n) => n.data.kind === "generationBlock");
  if (gens.length !== 1) return false;
  const genId = gens[0]!.id;

  const exportNodes = doc.nodes.filter((n) => n.data.kind === "platformExport");
  if (exportNodes.length !== 1) return false;
  const expNode = exportNodes[0]!;
  if (expNode.data.kind !== "platformExport") return false;
  if (expNode.data.platform !== "youtube") return false;

  return doc.edges.some((e) => {
    if (e.source !== genId || e.target !== expNode.id) return false;
    const sh = e.sourceHandle ?? null;
    const th = e.targetHandle ?? null;
    if (sh === "video" && th === "video") return true;
    if (sh === null && th === "video") return true;
    return false;
  });
}

function compactDialog(dialog: WorkflowAgentDialogTurn[]): WorkflowAgentDialogTurn[] {
  const maxChars = 12_000;
  const out: WorkflowAgentDialogTurn[] = [];
  let used = 0;
  for (let i = dialog.length - 1; i >= 0; i -= 1) {
    const t = dialog[i]!;
    const content = t.content.trim().slice(0, 6000);
    used += content.length;
    if (used > maxChars) break;
    out.push({ role: t.role, content });
  }
  return out.reverse();
}

export function workflowAgentLegacyUserContent(prompt: string): string {
  return `Build a workflow for this campaign request:\n\n${prompt.trim().slice(0, 6000)}`;
}

export type WorkflowAgentGenerateResult = {
  workflow: WorkflowDocument | null;
  /** Multi-step tool loop (e.g. lint then compile, or compile retries) */
  validationRepaired?: boolean;
};

export async function generateWorkflowWithOpenAI(
  dialog: WorkflowAgentDialogTurn[],
): Promise<WorkflowAgentGenerateResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { workflow: null };

  const modelId = process.env.OPENAI_WORKFLOW_MODEL?.trim() || DEFAULT_MODEL;
  const trimmedDialog = compactDialog(dialog);
  if (trimmedDialog.length === 0) return { workflow: null };
  const last = trimmedDialog[trimmedDialog.length - 1]!;
  if (last.role !== "user") return { workflow: null };

  const briefForCompile = extractCampaignBriefFromDialog(trimmedDialog).trim() || "Campaign";

  let resolvedWorkflow: WorkflowDocument | null = null;
  let compileAttempts = 0;

  const lintWorkflowPlan = tool({
    description:
      "Validate workflow plan JSON (structure only). Does not compile. Returns schema issues if any.",
    inputSchema: planJsonInputSchema,
    execute: async ({ planJson }) => {
      const parsedJson = parsePlanJson(planJson);
      if (!parsedJson.ok) {
        return { success: false as const, phase: "json" as const, error: parsedJson.error };
      }
      const validated = workflowPlanSchema.safeParse(parsedJson.plan);
      if (!validated.success) {
        return {
          success: false as const,
          phase: "schema" as const,
          issues: formatZodIssues(validated.error),
        };
      }
      return { success: true as const, stages: validated.data.stages.length };
    },
  });

  const compileWorkflowPlan = tool({
    description:
      "Validate plan with Zod, compile to canvas document, apply look-ref upgrade when needed. Call when the plan should ship.",
    inputSchema: planJsonInputSchema,
    execute: async ({ planJson }) => {
      compileAttempts += 1;
      const parsedJson = parsePlanJson(planJson);
      if (!parsedJson.ok) {
        return { success: false as const, error: `Invalid JSON: ${parsedJson.error}` };
      }
      const validated = workflowPlanSchema.safeParse(parsedJson.plan);
      if (!validated.success) {
        return { success: false as const, error: formatZodIssues(validated.error) };
      }

      const compiled = compileWorkflowPlanToDocument(validated.data, { brief: briefForCompile });
      if (!compiled.ok) {
        return { success: false as const, error: compiled.message };
      }

      let doc = compiled.document;
      if (isSingleGenYoutubeVideoExport(doc) && briefSuggestsLookRefPipeline(briefForCompile)) {
        doc = buildYoutubeLookRefThenVideoTemplate(briefForCompile, "youtube");
      }
      resolvedWorkflow = doc;
      return {
        success: true as const,
        nodeCount: doc.nodes.length,
        edgeCount: doc.edges.length,
      };
    },
  });

  const openai = createOpenAI({ apiKey: key });

  const result = await generateText({
    model: openai(modelId),
    system: SYSTEM,
    messages: trimmedDialog.map((t) => ({
      role: t.role,
      content: t.content,
    })),
    tools: {
      lint_workflow_plan: lintWorkflowPlan,
      compile_workflow_plan: compileWorkflowPlan,
    },
    prepareStep: ({ stepNumber }) => {
      if (resolvedWorkflow !== null) return {};
      if (stepNumber === 0) {
        return { toolChoice: { type: "tool", toolName: "compile_workflow_plan" } };
      }
      return {};
    },
    stopWhen: ({ steps }) => resolvedWorkflow !== null || steps.length >= 12,
    temperature: 0.35,
  });

  const steps = result.steps?.length ?? 0;
  const validationRepaired = steps > 1 || compileAttempts > 1;

  return {
    workflow: resolvedWorkflow,
    validationRepaired: resolvedWorkflow ? validationRepaired : undefined,
  };
}
