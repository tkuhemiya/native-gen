import { listFalModelCatalogForAgent } from "@/lib/fal/agent-model-catalog";
import {
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
  type GenerationPlan,
} from "@/lib/workflow/generation-plan";
import {
  buildIncomingByTarget,
  compileWorkflowPlanToDocument,
  safeParseWorkflowPlan,
  type WorkflowPlan,
} from "@/lib/workflow/workflow-plan";
import type { WorkflowDocument } from "@/lib/workflow/schema";

function formatZodIssues(error: import("zod").ZodError, maxIssues = 24): string {
  return error.issues
    .slice(0, maxIssues)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/** Readable multi-line summary of a validated plan (for the model + user). */
export function explainWorkflowPlan(plan: WorkflowPlan): { summary: string; stageCount: number } {
  const lines: string[] = [];
  lines.push(`**${plan.name}** (plan v${plan.version}) · ${plan.stages.length} stages`);
  for (const s of plan.stages) {
    if (s.kind === "mediaInput") {
      lines.push(`- **${s.id}** · mediaInput — user brief / uploads entry point`);
    } else if (s.kind === "generation") {
      const ins = s.inputs
        ? Object.entries(s.inputs)
            .map(([pin, ref]) => `${pin} ← \`${ref.fromStageId}\` (${ref.pin})`)
            .join("; ")
        : "(inputs mostly inferred: text from media when obvious)";
      lines.push(
        `- **${s.id}** · generation — **${s.label}** · outputs \`[${s.outputs.join(", ")}]\` · ${ins} · suffix: _${s.suffix.slice(0, 120)}${s.suffix.length > 120 ? "…" : ""}_`,
      );
    } else {
      const imgs = [s.imageFromStageId, ...(s.moreImageFromStageIds ?? [])].filter(Boolean);
      lines.push(
        `- **${s.id}** · platformExport · **${s.platform}** · copy: \`${s.copyFromStageId ?? "(default media)"}\` · images: \`${imgs.length ? imgs.join(", ") : "—"}\``,
      );
    }
  }
  return { summary: lines.join("\n"), stageCount: plan.stages.length };
}

export type CheckWorkflowDagResult =
  | {
      success: true;
      nodeCount: number;
      edgeCount: number;
      generationSummaries: Array<{
        label: string;
        intents: string[];
      }>;
    }
  | { success: false; phase: "json" | "schema" | "graph"; error: string };

function generationPlanToIntents(plan: GenerationPlan): string[] {
  const intents: string[] = [];
  if (plan.needPassthroughText) intents.push("passthrough-text");
  if (plan.needCaption) intents.push("image-to-text");
  if (plan.needTextToImage) {
    intents.push(plan.needReferenceImageEdit ? "openai-gpt-image-2-edit" : "text-to-image");
  }
  if (plan.needMarketingSocialCopy) intents.push("marketing-social-copy");
  return intents;
}

function summarizeGenerationsFromDocument(doc: WorkflowDocument): Array<{ label: string; intents: string[] }> {
  const incomingByTarget = buildIncomingByTarget(doc.edges);
  const out: Array<{ label: string; intents: string[] }> = [];
  for (const node of doc.nodes) {
    if (node.data.kind !== "generationBlock") continue;
    const inL = incomingMediaLanes(node.id, incomingByTarget);
    const outL = outgoingMediaLanes(node.id, doc.edges);
    const g = planGeneration(inL, outL);
    out.push({
      label: node.data.label.trim() || node.data.kind,
      intents: generationPlanToIntents(g),
    });
  }
  return out;
}

/** Same connectivity + generation-pin rules as compile, without persisting ( resultado mirrors compile errors). */
export function checkWorkflowDag(
  plan: WorkflowPlan,
  ctx: { brief: string },
): CheckWorkflowDagResult {
  const compiled = compileWorkflowPlanToDocument(plan, ctx);
  if (!compiled.ok) {
    return { success: false, phase: "graph", error: compiled.message };
  }
  const doc = compiled.document;
  return {
    success: true,
    nodeCount: doc.nodes.length,
    edgeCount: doc.edges.length,
    generationSummaries: summarizeGenerationsFromDocument(doc),
  };
}

export type EstimatePlanCostResult =
  | {
      success: true;
      /** Ordered fal-style intents per generation block */
      lineItems: Array<{
        label: string;
        intents: string[];
        relativeUnits: number;
      }>;
      totalRelativeUnits: number;
      disclaimer: string;
    }
  | { success: false; phase: "json" | "schema" | "graph"; error: string };

function relativeUnitsForGeneration(plan: GenerationPlan): number {
  let u = 0;
  if (plan.needPassthroughText) u += 0;
  if (plan.needCaption) u += 2;
  if (plan.needReferenceImageEdit) u += 6;
  if (plan.needTextToImage && !plan.needReferenceImageEdit) u += 5;
  if (plan.needMarketingSocialCopy) u += 1;
  return u;
}

/**
 * Heuristic-only cost proxy: higher `relativeUnits` ≈ more GPU. Not USD — see disclaimer.
 */
export function estimatePlanCost(
  plan: WorkflowPlan,
  ctx: { brief: string },
): EstimatePlanCostResult {
  const compiled = compileWorkflowPlanToDocument(plan, ctx);
  if (!compiled.ok) {
    return { success: false, phase: "graph", error: compiled.message };
  }
  const doc = compiled.document;
  const incomingByTarget = buildIncomingByTarget(doc.edges);
  const rows: Array<{ label: string; intents: string[]; relativeUnits: number }> = [];
  for (const node of doc.nodes) {
    if (node.data.kind !== "generationBlock") continue;
    const inL = incomingMediaLanes(node.id, incomingByTarget);
    const outL = outgoingMediaLanes(node.id, doc.edges);
    const g = planGeneration(inL, outL);
    const intents = generationPlanToIntents(g);
    rows.push({
      label: node.data.label.trim() || node.data.kind,
      intents,
      relativeUnits: relativeUnitsForGeneration(g),
    });
  }
  const totalRelativeUnits = rows.reduce((a, r) => a + r.relativeUnits, 0);
  return {
    success: true,
    lineItems: rows,
    totalRelativeUnits,
    disclaimer:
      "`relativeUnits` are rough comparables inside this app (not USD). Open each fal model page for live pricing.",
  };
}

export function listGenerationModelsForAgent(): { models: ReturnType<typeof listFalModelCatalogForAgent> } {
  return { models: listFalModelCatalogForAgent() };
}

/** Shared parse + Zod for tools that take planJson string. */
export function parseAndValidatePlanJson(planJson: string):
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; phase: "json" | "schema"; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(planJson) as unknown;
  } catch (e) {
    return {
      ok: false,
      phase: "json",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const validated = safeParseWorkflowPlan(raw);
  if (!validated.success) {
    return { ok: false, phase: "schema", error: formatZodIssues(validated.error) };
  }
  return { ok: true, plan: validated.data };
}
