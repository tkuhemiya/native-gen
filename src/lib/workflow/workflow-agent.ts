import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

import {
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "./schema";
import {
  stripWorkflowMediaForAgent,
  validateAndFinalizeWorkflowWrite,
} from "./workflow-canvas-agent";

const emptyToolInputSchema = z.object({});

const workflowJsonInputSchema = z.object({
  workflowJson: z
    .string()
    .min(4)
    .describe(
      "Full WorkflowDocument JSON string: id, name, version, updatedAt, nodes[], edges[]. Must match app schema (v3).",
    ),
});

const SYSTEM = `You are a **workflow editor**: you read the canvas as JSON and apply user intent by calling **write_workflow_canvas** with the **complete** updated document (like saving a file in an IDE).

## WorkflowDocument shape
- **Root:** \`id\` (uuid string), \`name\`, \`version\`: ${WORKFLOW_DOCUMENT_VERSION}, \`updatedAt\` (ISO-8601 string), \`nodes\`, \`edges\`
- **Node:** \`id\`, \`type\` (\`mediaInput\` | \`generationBlock\` | \`platformExport\`), \`position\` { x, y }, \`data\` (must match type)
  - **mediaInput** \`data\`: \`kind: "mediaInput"\`, \`label\`, \`value\` (brief text), \`images\`[], \`videos\`[] — use empty arrays unless you intentionally clear uploads
  - **generationBlock** \`data\`: \`kind: "generationBlock"\`, \`label\`, \`suffix\`, \`imageSize\` (e.g. \`landscape_16_9\`), \`numInferenceSteps\` (1–12), \`videoDuration\` (\`4s\`|\`6s\`|\`8s\`), \`videoResolution\`, \`videoSilent\`, \`wanDurationSec\`, \`wanResolution\`
  - **platformExport** \`data\`: \`kind: "platformExport"\`, \`label\`, \`platform\` (\`youtube\`|\`facebook\`|\`instagram\`|\`tiktok\`), optional \`metaPageId\`
- **Edge:** \`id\`, \`source\`, \`target\` (node ids), \`sourceHandle\`, \`targetHandle\` — \`"text"\`, \`"image"\`, or \`"video"\` (nullable handles allowed per schema)

## Graph rules (enforced on write)
- Must be a **connected DAG** (no cycles, no disconnected nodes).
- Every **generationBlock** needs **≥1 outgoing** edge (to another generation or to platformExport) matching outputs (text/image/video pins).
- **Edits:** reuse existing **node ids** when reasonable so user uploads and state stay tied to the same blocks.

## Story & graph complexity (**strong default**)
- **Avoid** collapsing everything into the **tiny 3-node** pattern (mediaInput → **one** generationBlock → platformExport) unless the user **explicitly** wants a single asset, one hero shot, or “simplest / fastest / minimal” output.
- For **stories, narratives, campaigns, arcs, scenes, beats, kids/families, multiple characters, “# kids”, “each kid”, carousels, or episodic** asks: design a **wide, readable DAG** with **many generationBlocks** — mix **sequential** story depth and **parallel** lanes where the brief fits.
- **Sequential beats (chain text → text → … → image/video):** give **each narrative or visual beat its own** \`generationBlock\` with a clear \`label\` and **specific** \`suffix\` (examples: \`story-bible\`, \`scene-outline\`, \`beat1-establish\`, \`beat2-conflict\`, \`beat3-payoff\`, \`Keyframe-wide\`, \`motion-i2v\`). Wire **text** outputs forward into the next block’s **text** input so copy and story state flow through the chain; add **image**/**video** blocks where outputs should be visuals, then route into export.
- **Parallel subjects:** if the brief implies **count**, **several people**, **per-kid**, **variants**, or placeholders like \`# kids\`, add **one generationBlock per subject or variant** fed from the same (or split) **text** lane; wire **each** subject’s **image** (or **video**) pins into **platformExport** — **multiple edges** into the export’s \`image\` handle are allowed.
- **Concrete target:** for narrative/campaign-style requests, aim for **≥5 generationBlocks** before export (often **6–12+** is appropriate). More connected blocks are **better** than an under-specified pipeline as long as the graph stays a valid DAG.
- Usually keep **one** \`platformExport\` at the end; merge parallel lanes into it unless the user names multiple distinct destinations.

## Media in snapshots
The **Canvas snapshot** below strips **image/video binary data** from mediaInput nodes. If you omit or leave \`images\`/\`videos\` empty for a node id that already existed, the **server keeps** the user’s prior uploads for that id.

## Tools (only these)
- **read_workflow_canvas** — returns current JSON (same as snapshot); optional refresh.
- **write_workflow_canvas** — pass **workflowJson** (single string, entire document). **Required** to apply the graph.

Call **write_workflow_canvas** with a full valid JSON graph. On failure it returns \`success: false\`, \`error\` (summary), and **\`issues\`** (per-line problems). Fix **every** issue and call **write_workflow_canvas** again.`;

const DEFAULT_MODEL = "gpt-5.4-mini";

/** Human-facing log line */
function clipTelemetryLine(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function describeWriteToolOutput(output: unknown): {
  ok: boolean;
  detail: string;
  issues?: string[];
} {
  if (!output || typeof output !== "object") {
    return { ok: false, detail: "write_workflow_canvas: unexpected output" };
  }
  const o = output as Record<string, unknown>;
  if (o.success === true) {
    const nc = o.nodeCount;
    const ec = o.edgeCount;
    if (typeof nc === "number" && typeof ec === "number") {
      return { ok: true, detail: `Wrote canvas (${nc} nodes, ${ec} edges)` };
    }
    return { ok: true, detail: "Wrote canvas" };
  }
  if (o.success === false && typeof o.error === "string") {
    const rawIssues = o.issues;
    const issues =
      Array.isArray(rawIssues) && rawIssues.every((x) => typeof x === "string")
        ? (rawIssues as string[])
        : undefined;
    const detail =
      issues && issues.length
        ? `${o.error}\n${issues.map((line) => `- ${line}`).join("\n")}`
        : o.error;
    return { ok: false, detail, issues };
  }
  return { ok: false, detail: `write_workflow_canvas: ${JSON.stringify(o)}` };
}

function describeGenericToolFailure(toolName: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.success !== false) return null;
  const err = typeof o.error === "string" ? o.error : JSON.stringify(o);
  return `${toolName}: ${err}`;
}

function lastFailedWriteFromSteps(
  steps: Array<{
    staticToolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): { error: string; issues: string[] } | null {
  for (let s = steps.length - 1; s >= 0; s -= 1) {
    const step = steps[s]!;
    const merged = [...(step.staticToolResults ?? []), ...(step.toolResults ?? [])];
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const tr = merged[i]!;
      if (tr.toolName !== "write_workflow_canvas") continue;
      const o = tr.output as Record<string, unknown> | null;
      if (!o || o.success !== false) continue;
      const error = typeof o.error === "string" ? o.error : "write_workflow_canvas failed";
      const raw = o.issues;
      const issues =
        Array.isArray(raw) && raw.every((x) => typeof x === "string") && raw.length > 0
          ? [...(raw as string[])]
          : [error];
      return { error, issues };
    }
  }
  return null;
}

function summarizeFailuresFromSteps(
  steps: Array<{
    staticToolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>,
): string {
  const lines: string[] = [];
  for (const step of steps) {
    const merged = [...(step.staticToolResults ?? []), ...(step.toolResults ?? [])];
    for (const tr of merged) {
      if (tr.toolName === "write_workflow_canvas") {
        const d = describeWriteToolOutput(tr.output);
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
  validationRepaired?: boolean;
  agentLog?: string[];
  /** Set when the model or planner exits without a valid workflow (for API / UI feedback). */
  validationError?: string;
  validationIssues?: string[];
};

const DEFAULT_PLANNER_ROUNDS = 4;

export type GenerateWorkflowOptions = {
  /** Current canvas (optional). Stripped in prompt; used to restore media on write. */
  canvasSnapshot?: WorkflowDocument | null;
};

export async function generateWorkflowWithOpenAI(
  dialog: WorkflowAgentDialogTurn[],
  options: GenerateWorkflowOptions = {},
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
  const canvasSnapshot = options.canvasSnapshot ?? null;

  const snapshotForPrompt = canvasSnapshot ? stripWorkflowMediaForAgent(canvasSnapshot) : null;
  const canvasBlock = snapshotForPrompt
    ? `\n\n## Canvas snapshot (media binary stripped; empty arrays here still restore prior uploads per node id on save)\n\`\`\`json\n${JSON.stringify(snapshotForPrompt, null, 2)}\n\`\`\``
    : `\n\n## Canvas snapshot\n_(empty — new WorkflowDocument from the user brief: **bias toward a rich graph** — typically **one** \`mediaInput\`, **several** chained **and** forked \`generationBlock\` nodes for story beats / parallel subjects (\`# kids\`, etc.), then **one** \`platformExport\`; version ${WORKFLOW_DOCUMENT_VERSION}; fresh uuids. Avoid the minimal 3-node pipeline unless the brief is explicitly minimal.)_`;

  const agentLog: string[] = [];
  let resolvedWorkflow: WorkflowDocument | null = null;
  let totalWriteAttempts = 0;
  let outerRepairPasses = 0;
  let maxInnerStepsUsed = 0;
  let terminalValidation: { error: string; issues: string[] } | null = null;

  const openai = createOpenAI({ apiKey: key });

  for (let round = 0; round < maxPlannerRounds && !resolvedWorkflow; round += 1) {
    if (round === 0) {
      agentLog.push("Starting canvas agent…");
    } else {
      outerRepairPasses += 1;
      agentLog.push(`Fix pass ${round + 1} of ${maxPlannerRounds}…`);
    }

    let innerResolved: WorkflowDocument | null = null;

    const readWorkflowCanvasTool = tool({
      description:
        "Return the current canvas WorkflowDocument as JSON (same as system snapshot; media blobs stripped). Optional.",
      inputSchema: emptyToolInputSchema,
      execute: async () => {
        const stripped = canvasSnapshot ? stripWorkflowMediaForAgent(canvasSnapshot) : null;
        return {
          success: true as const,
          empty: !canvasSnapshot,
          workflowJson: stripped ? JSON.stringify(stripped, null, 2) : "",
        };
      },
    });

    const writeWorkflowCanvasTool = tool({
      description:
        "Apply the full WorkflowDocument JSON in workflowJson. For stories/campaigns/multi-subject briefs, use many chained and/or parallel generationBlocks (see system prompt) — do not shrink to a single generate node unless the user asked for minimal output.",
      inputSchema: workflowJsonInputSchema,
      execute: async ({ workflowJson }) => {
        totalWriteAttempts += 1;
        const result = validateAndFinalizeWorkflowWrite(workflowJson, {
          brief: briefForCompile,
          previousCanvas: canvasSnapshot,
        });
        if (!result.ok) {
          return {
            success: false as const,
            error: result.error,
            issues: result.issues,
          };
        }
        innerResolved = result.document;
        resolvedWorkflow = result.document;
        return {
          success: true as const,
          nodeCount: result.document.nodes.length,
          edgeCount: result.document.edges.length,
        };
      },
    });

    const result = await generateText({
      model: openai(modelId),
      system: SYSTEM + canvasBlock,
      messages: workingDialog.map((t) => ({
        role: t.role,
        content: t.content,
      })),
      tools: {
        read_workflow_canvas: readWorkflowCanvasTool,
        write_workflow_canvas: writeWorkflowCanvasTool,
      },
      prepareStep: ({ stepNumber }) => {
        if (innerResolved !== null) return {};
        if (stepNumber === 0) {
          return { toolChoice: { type: "tool", toolName: "write_workflow_canvas" } };
        }
        return {};
      },
      stopWhen: ({ steps }) => innerResolved !== null || steps.length >= 24,
      temperature: 0.42,
      experimental_onToolCallStart: ({ toolCall }) => {
        const name = toolCall.toolName;
        if (name === "read_workflow_canvas") agentLog.push("Reading workflow JSON…");
        if (name === "write_workflow_canvas") agentLog.push("Writing workflow JSON…");
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
        if (name === "write_workflow_canvas") {
          const d = describeWriteToolOutput(output);
          agentLog.push(clipTelemetryLine(d.detail));
          return;
        }
        if (name === "read_workflow_canvas") {
          const o = output as Record<string, unknown>;
          agentLog.push(
            o.empty
              ? "Read canvas (empty)"
              : "Read canvas JSON (media stripped in tool response)",
          );
        }
      },
    });

    const innerSteps = result.steps?.length ?? 0;
    maxInnerStepsUsed = Math.max(maxInnerStepsUsed, innerSteps);

    if (resolvedWorkflow) {
      agentLog.push("Workflow is ready to apply.");
      break;
    }

    const failureSummary = summarizeFailuresFromSteps(result.steps ?? []);
    const lastWriteErr = lastFailedWriteFromSteps(result.steps ?? []);
    const fallback =
      failureSummary ||
      (result.text?.trim()
        ? `Model finished without a valid write. Last assistant text:\n${result.text.trim().slice(0, 2000)}`
        : "Call write_workflow_canvas with a full valid WorkflowDocument JSON string.");

    terminalValidation =
      lastWriteErr ??
      (failureSummary
        ? { error: failureSummary, issues: [...new Set(failureSummary.split("\n\n").filter(Boolean))] }
        : { error: fallback, issues: [fallback] });

    const modelRepairText = lastWriteErr
      ? [lastWriteErr.error, "", ...lastWriteErr.issues.map((line) => `- ${line}`)].join("\n")
      : fallback;

    if (round + 1 >= maxPlannerRounds) {
      agentLog.push(
        clipTelemetryLine(`Giving up after ${maxPlannerRounds} rounds: ${terminalValidation.error}`),
      );
      break;
    }

    agentLog.push("Sending validation errors back for correction…");
    workingDialog = compactDialog([
      ...workingDialog,
      {
        role: "user",
        content: [
          "The workflow JSON did not validate or the graph rules failed. Fix everything below, then call write_workflow_canvas again with the full corrected workflowJson string.",
          "",
          modelRepairText,
        ].join("\n"),
      },
    ]);
  }

  const validationRepaired =
    resolvedWorkflow !== null &&
    (outerRepairPasses > 0 || maxInnerStepsUsed > 1 || totalWriteAttempts > 1);

  if (resolvedWorkflow) {
    return {
      workflow: resolvedWorkflow,
      validationRepaired: validationRepaired || undefined,
      agentLog,
    };
  }

  return {
    workflow: null,
    agentLog,
    validationError:
      terminalValidation?.error ??
      "The workflow agent could not produce a graph that passes validation.",
    ...(terminalValidation?.issues?.length ? { validationIssues: terminalValidation.issues } : {}),
  };
}
