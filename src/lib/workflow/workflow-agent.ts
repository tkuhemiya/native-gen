import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

import { buildYoutubeLookRefThenVideoTemplate } from "./template-from-brief";
import type { WorkflowDocument } from "./schema";
import { compileWorkflowPlanToDocument, safeParseWorkflowPlan } from "./workflow-plan";
import {
  checkWorkflowDag,
  estimatePlanCost,
  explainWorkflowPlan,
  listGenerationModelsForAgent,
  parseAndValidatePlanJson,
} from "./workflow-agent-tools";

/** Plan JSON as a string keeps OpenAI tool schemas small; Zod runs in execute. */
const planJsonInputSchema = z.object({
  planJson: z
    .string()
    .min(4)
    .describe("Full workflow plan as a JSON string: version, name, stages (see system prompt)."),
});

const emptyToolInputSchema = z.object({});

const SYSTEM = `You build a workflow **plan** for our canvas (not raw graph JSON). Prefer **rich, editable graphs**: multiple generation stages beat a single generic text-only block unless the user clearly wants copy-only output.

Stages are ordered left-to-right:
1) Exactly one mediaInput — use id "media" unless the user already used another id in thread; brief text is injected server-side.
2) Zero or more generation stages — label, suffix, outputs (text/image/video), optional inputs (target pin → fromStageId + pin).
3) One platformExport — platform, optional copyFromStageId, imageFromStageId, optional **moreImageFromStageIds** (array of extra image stages), videoFromStageId.

**Creative layouts (important):**
- If the brief mentions **several characters, people, products, shots, beats, or variants** (e.g. “three kids”, “each founder”, “option A/B”), add **one generation stage per distinct visual** when practical. Give each a **unique label** and **suffix** so the user can tweak one subject on the canvas without redoing the whole story.
- **Parallel portraits:** use multiple \`generation\` stages with \`outputs: ["image"]\`, each with \`inputs.text\` from the media stage (\`fromStageId: "media"\`, \`pin: "text"\`) and a suffix that describes **only that subject** (wardrobe, age vibe, framing).
- **Export with several images:** set \`imageFromStageId\` to the **first** kid/asset stage, and list the others in \`moreImageFromStageIds\` (same order as you want in a carousel when possible). The app wires all of them into the export node’s image pin.
- **Video from many images:** the runner’s image→video path uses **one** reference frame at a time. Valid patterns: (1) **text→video** final stage whose suffix summarizes all subjects / the scene; (2) **image→video** fed from **one** chosen hero stage (user can rewire to another kid on the canvas); (3) skip video and ship a **multi-image** export for static carousels — often best for “N kids” portraits.
- **Do not** collapse “N subjects” into one default \`outputs: ["text"]\` block unless the user asked for **text-only** output.

**Tools (use them):**
- \`explain_workflow_plan\` — human-readable summary of stages and wiring from planJson.
- \`check_workflow_dag\` — validates compile, connectivity (DAG), and generation pin rules; use before shipping if unsure.
- \`list_generation_models\` — fal endpoints configured on the server (text→image/video, etc.).
- \`estimate_plan_cost\` — rough **relative** cost units per generation block (not USD; see disclaimer in result).
- \`lint_workflow_plan\` — Zod/schema only; quick structure check.
- \`compile_workflow_plan\` — validates, compiles to a runnable document, **must** succeed for the user to get a workflow.

You may call the read-only tools first. **Finish by calling \`compile_workflow_plan\`** with the full \`planJson\` string. If a tool returns errors, fix the plan and try again.

**Schema guardrails (must match exactly or tools fail):**
- \`version\` must be the JSON number \`1\` (not a string, not \`"v1"\`).
- Every stage \`kind\` must be exactly one of: \`"mediaInput"\`, \`"generation"\`, \`"platformExport"\` (camelCase).
- **Never** put \`"copy"\`, \`"caption"\`, or \`"text"\` in \`platform\`. Those are not platforms. Use \`platform\`: \`"youtube"\` | \`"facebook"\` | \`"instagram"\` | \`"tiktok"\` only, and set \`copyFromStageId\` to the media stage id (usually \`"media"\`) for caption/copy source.

**Reference plan — 3 parallel kid portraits → Instagram carousel (copy this shape when the user asks for several subjects / kids):**
{"version":1,"name":"Three kids","stages":[{"id":"media","kind":"mediaInput","label":"Brief"},{"id":"kid1","kind":"generation","label":"Kid 1","suffix":"Portrait of the first child, warm storybook illustration, full face.","outputs":["image"],"inputs":{"text":{"fromStageId":"media","pin":"text"}}},{"id":"kid2","kind":"generation","label":"Kid 2","suffix":"Portrait of the second child, distinct look, same storybook style.","outputs":["image"],"inputs":{"text":{"fromStageId":"media","pin":"text"}}},{"id":"kid3","kind":"generation","label":"Kid 3","suffix":"Portrait of the third child, unique details, same storybook style.","outputs":["image"],"inputs":{"text":{"fromStageId":"media","pin":"text"}}},{"id":"out","kind":"platformExport","platform":"instagram","copyFromStageId":"media","imageFromStageId":"kid1","moreImageFromStageIds":["kid2","kid3"]}]}

The server may also send you follow-up user messages listing validation errors; treat those as authoritative and repair the plan.

Keep stage ids short ("media", "kid1", "kid2", "kid3", "out").`;

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

const DEFAULT_PLANNER_ROUNDS = 4;

/** Human-facing log line; keep short for the chat panel */
function clipTelemetryLine(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function telemetryLineForToolOutput(toolName: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return `${toolName} done`;
  const o = output as Record<string, unknown>;
  if (o.success === false) {
    const err = typeof o.error === "string" ? o.error : JSON.stringify(o);
    return `${toolName}: ${err}`;
  }
  switch (toolName) {
    case "explain_workflow_plan":
      return typeof o.stageCount === "number"
        ? `Explained plan (${o.stageCount} stages)`
        : "Explained plan";
    case "check_workflow_dag":
      return typeof o.nodeCount === "number" && typeof o.edgeCount === "number"
        ? `DAG check OK (${o.nodeCount} nodes, ${o.edgeCount} edges)`
        : "DAG check OK";
    case "list_generation_models":
      return "Listed generation endpoints";
    case "estimate_plan_cost":
      return typeof o.totalRelativeUnits === "number"
        ? `Cost estimate · ${o.totalRelativeUnits} relative units (see disclaimer)`
        : "Cost estimate ready";
    default:
      return null;
  }
}

function describePlanToolOutput(
  toolName: "lint_workflow_plan" | "compile_workflow_plan",
  output: unknown,
): { ok: boolean; detail: string } {
  if (!output || typeof output !== "object") {
    return { ok: false, detail: `${toolName}: unexpected tool output` };
  }
  const o = output as Record<string, unknown>;
  if (o.success === true) {
    if (toolName === "lint_workflow_plan") {
      const n = o.stages;
      return {
        ok: true,
        detail: typeof n === "number" ? `Lint passed (${n} stages)` : "Lint passed",
      };
    }
    const nc = o.nodeCount;
    const ec = o.edgeCount;
    if (typeof nc === "number" && typeof ec === "number") {
      return { ok: true, detail: `Compiled to canvas (${nc} nodes, ${ec} edges)` };
    }
    return { ok: true, detail: "Compiled to canvas" };
  }
  if (o.success === false) {
    const err =
      typeof o.error === "string"
        ? o.error
        : typeof o.issues === "string"
          ? o.issues
          : JSON.stringify(o);
    const phase = o.phase === "json" || o.phase === "schema" ? ` [${o.phase}]` : "";
    return { ok: false, detail: `${toolName}${phase}: ${err}` };
  }
  return { ok: false, detail: `${toolName}: ${JSON.stringify(o)}` };
}

function describeGenericToolFailure(toolName: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.success !== false) return null;
  const err =
    typeof o.error === "string"
      ? o.error
      : typeof o.issues === "string"
        ? o.issues
        : JSON.stringify(o);
  const phase = o.phase === "json" || o.phase === "schema" || o.phase === "graph" ? ` [${o.phase}]` : "";
  return `${toolName}${phase}: ${err}`;
}

/**
 * Summarize validation/compile failures from a generateText run for model feedback.
 */
function summarizePlannerFailuresFromSteps(
  steps: Array<{
    staticToolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): string {
  const lines: string[] = [];
  for (const step of steps) {
    const merged = [...(step.staticToolResults ?? []), ...(step.toolResults ?? [])];
    for (const tr of merged) {
      if (tr.toolName === "lint_workflow_plan" || tr.toolName === "compile_workflow_plan") {
        const d = describePlanToolOutput(
          tr.toolName as "lint_workflow_plan" | "compile_workflow_plan",
          tr.output,
        );
        if (!d.ok) lines.push(d.detail);
        continue;
      }
      const g = describeGenericToolFailure(tr.toolName, tr.output);
      if (g) lines.push(g);
    }
  }
  if (lines.length) return [...new Set(lines)].join("\n\n");
  return "";
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
  /** Ordered status lines for the chat UI (tool calls, repairs, outcomes). */
  agentLog?: string[];
};

export async function generateWorkflowWithOpenAI(
  dialog: WorkflowAgentDialogTurn[],
): Promise<WorkflowAgentGenerateResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { workflow: null };

  const modelId = process.env.OPENAI_WORKFLOW_MODEL?.trim() || DEFAULT_MODEL;
  const rawRounds = process.env.WORKFLOW_AGENT_MAX_PLANNER_ROUNDS?.trim();
  const parsedRounds = rawRounds ? Number.parseInt(rawRounds, 10) : NaN;
  const maxPlannerRounds = Math.max(
    1,
    Math.min(8, Number.isFinite(parsedRounds) && parsedRounds > 0 ? parsedRounds : DEFAULT_PLANNER_ROUNDS),
  );

  let workingDialog = compactDialog(dialog);
  if (workingDialog.length === 0) return { workflow: null };
  const last = workingDialog[workingDialog.length - 1]!;
  if (last.role !== "user") return { workflow: null };

  const briefForCompile = extractCampaignBriefFromDialog(workingDialog).trim() || "Campaign";

  const agentLog: string[] = [];
  let resolvedWorkflow: WorkflowDocument | null = null;
  let totalCompileAttempts = 0;
  let outerRepairPasses = 0;
  let maxInnerStepsUsed = 0;

  const openai = createOpenAI({ apiKey: key });

  for (let round = 0; round < maxPlannerRounds && !resolvedWorkflow; round += 1) {
    if (round === 0) {
      agentLog.push("Starting planner for your request…");
    } else {
      outerRepairPasses += 1;
      agentLog.push(`Schema feedback loop — pass ${round + 1} of ${maxPlannerRounds}…`);
    }

    let innerResolved: WorkflowDocument | null = null;

    const explainWorkflowPlanTool = tool({
      description:
        "Summarize planJson in plain language: each stage, outputs, wiring, and export targets. Read-only.",
      inputSchema: planJsonInputSchema,
      execute: async ({ planJson }) => {
        const parsed = parseAndValidatePlanJson(planJson);
        if (!parsed.ok) {
          return { success: false as const, phase: parsed.phase, error: parsed.error };
        }
        const { summary, stageCount } = explainWorkflowPlan(parsed.plan);
        return { success: true as const, summary, stageCount };
      },
    });

    const checkWorkflowDagTool = tool({
      description:
        "Validate structure + graph: same checks as compile (connected DAG, generation pin rules). Does not apply to user canvas.",
      inputSchema: planJsonInputSchema,
      execute: async ({ planJson }) => {
        const parsed = parseAndValidatePlanJson(planJson);
        if (!parsed.ok) {
          return { success: false as const, phase: parsed.phase, error: parsed.error };
        }
        const r = checkWorkflowDag(parsed.plan, { brief: briefForCompile });
        if (!r.success) {
          return { success: false as const, phase: r.phase, error: r.error };
        }
        return {
          success: true as const,
          nodeCount: r.nodeCount,
          edgeCount: r.edgeCount,
          generationSummaries: r.generationSummaries,
        };
      },
    });

    const listGenerationModelsTool = tool({
      description:
        "List configured fal endpoints for this app (text→image, text→video, image→video, caption). No arguments.",
      inputSchema: emptyToolInputSchema,
      execute: async () => {
        const { models } = listGenerationModelsForAgent();
        return { success: true as const, models };
      },
    });

    const estimatePlanCostTool = tool({
      description:
        "Estimate relative cost weight per generation block from wiring (not USD; includes disclaimer).",
      inputSchema: planJsonInputSchema,
      execute: async ({ planJson }) => {
        const parsed = parseAndValidatePlanJson(planJson);
        if (!parsed.ok) {
          return { success: false as const, phase: parsed.phase, error: parsed.error };
        }
        const r = estimatePlanCost(parsed.plan, { brief: briefForCompile });
        if (!r.success) {
          return { success: false as const, phase: r.phase, error: r.error };
        }
        return {
          success: true as const,
          lineItems: r.lineItems,
          totalRelativeUnits: r.totalRelativeUnits,
          disclaimer: r.disclaimer,
        };
      },
    });

    const lintWorkflowPlan = tool({
      description:
        "Validate workflow plan JSON (structure only). Does not compile. Returns schema issues if any.",
      inputSchema: planJsonInputSchema,
      execute: async ({ planJson }) => {
        const parsedJson = parsePlanJson(planJson);
        if (!parsedJson.ok) {
          return { success: false as const, phase: "json" as const, error: parsedJson.error };
        }
        const validated = safeParseWorkflowPlan(parsedJson.plan);
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
        totalCompileAttempts += 1;
        const parsedJson = parsePlanJson(planJson);
        if (!parsedJson.ok) {
          return { success: false as const, error: `Invalid JSON: ${parsedJson.error}` };
        }
        const validated = safeParseWorkflowPlan(parsedJson.plan);
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
        innerResolved = doc;
        resolvedWorkflow = doc;
        return {
          success: true as const,
          nodeCount: doc.nodes.length,
          edgeCount: doc.edges.length,
        };
      },
    });

    const result = await generateText({
      model: openai(modelId),
      system: SYSTEM,
      messages: workingDialog.map((t) => ({
        role: t.role,
        content: t.content,
      })),
      tools: {
        explain_workflow_plan: explainWorkflowPlanTool,
        check_workflow_dag: checkWorkflowDagTool,
        list_generation_models: listGenerationModelsTool,
        estimate_plan_cost: estimatePlanCostTool,
        lint_workflow_plan: lintWorkflowPlan,
        compile_workflow_plan: compileWorkflowPlan,
      },
      stopWhen: ({ steps }) => innerResolved !== null || steps.length >= 18,
      temperature: 0.42,
      experimental_onToolCallStart: ({ toolCall }) => {
        const name = toolCall.toolName;
        if (name === "explain_workflow_plan") agentLog.push("Summarizing plan stages…");
        if (name === "check_workflow_dag") agentLog.push("Validating DAG and edges…");
        if (name === "list_generation_models") agentLog.push("Listing fal endpoints…");
        if (name === "estimate_plan_cost") agentLog.push("Estimating relative run cost…");
        if (name === "lint_workflow_plan") agentLog.push("Checking plan against schema…");
        if (name === "compile_workflow_plan") agentLog.push("Compiling plan to the canvas graph…");
      },
      experimental_onToolCallFinish: ({ toolCall, success, output, error }) => {
        const name = toolCall.toolName;
        if (!success) {
          agentLog.push(
            clipTelemetryLine(
              `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return;
        }
        if (name === "lint_workflow_plan" || name === "compile_workflow_plan") {
          const d = describePlanToolOutput(
            name as "lint_workflow_plan" | "compile_workflow_plan",
            output,
          );
          agentLog.push(clipTelemetryLine(d.detail));
          return;
        }
        const line = telemetryLineForToolOutput(name, output);
        if (line) agentLog.push(clipTelemetryLine(line));
      },
    });

    const innerSteps = result.steps?.length ?? 0;
    maxInnerStepsUsed = Math.max(maxInnerStepsUsed, innerSteps);

    if (resolvedWorkflow) {
      agentLog.push("Workflow is ready to apply.");
      break;
    }

    const failureSummary = summarizePlannerFailuresFromSteps(result.steps ?? []);
    const fallback =
      failureSummary ||
      (result.text?.trim()
        ? `Model finished without a compiled workflow. Last assistant text:\n${result.text.trim().slice(0, 2000)}`
        : "Model finished without a compiled workflow. Call compile_workflow_plan with valid planJson.");

    if (round + 1 >= maxPlannerRounds) {
      agentLog.push(clipTelemetryLine(`Giving up after ${maxPlannerRounds} planner rounds: ${fallback}`));
      break;
    }

    agentLog.push("Sending validation errors back to the model for a fix…");
    workingDialog = compactDialog([
      ...workingDialog,
      {
        role: "user",
        content: [
          "The workflow plan did not compile successfully. Fix every issue below, then call compile_workflow_plan again with the full corrected planJson string.",
          "",
          fallback,
        ].join("\n"),
      },
    ]);
  }

  const validationRepaired =
    resolvedWorkflow !== null && (outerRepairPasses > 0 || maxInnerStepsUsed > 1 || totalCompileAttempts > 1);

  return {
    workflow: resolvedWorkflow,
    ...(resolvedWorkflow
      ? {
          validationRepaired: validationRepaired || undefined,
          agentLog,
        }
      : { agentLog }),
  };
}
