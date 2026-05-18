import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import { z } from "zod";

import { assertConnectedDAG, GraphError } from "./graph";
import { incomingMediaLanes, outgoingMediaLanes, planGeneration } from "./generation-plan";
import { layoutWorkflowNodesCompactDAG } from "./node-layout";
import { reconcileGenerationImageSizes } from "./platform-aspect-presets";
import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

const modalitySchema = z.enum(["text", "image"]);

const stageInputPinSchema = z.object({
  fromStageId: z.string().min(1),
  pin: modalitySchema,
});

const generationSettingsSchema = z.object({
  imageSize: falFluxPresetSizeSchema.optional(),
  numInferenceSteps: z.number().int().min(1).max(12).optional(),
});

const planTextPrimitiveStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("textPrimitive"),
  label: z.string().optional(),
});

const planGenerationStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("generation"),
  label: z.string().min(1),
  suffix: z.string(),
  outputs: z.array(modalitySchema).min(1),
  inputs: z.record(modalitySchema, stageInputPinSchema).optional(),
  settings: generationSettingsSchema.optional(),
});

const planOutputStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("outputBlock"),
  label: z.string().optional(),
  mediaFromStageId: z.string().min(1),
  /** Which outbound pin on the upstream node feeds preview/export. */
  sourcePin: z.enum(["image", "video", "text"]).default("image"),
});

export const workflowPlanSchema = z.object({
  version: z.preprocess((val) => {
    if (val === "1" || val === 1) return 1;
    return val;
  }, z.literal(1)),
  name: z.string().min(1),
  stages: z
    .array(
      z.discriminatedUnion("kind", [
        planTextPrimitiveStageSchema,
        planGenerationStageSchema,
        planOutputStageSchema,
      ]),
    )
    .min(2),
});

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

type EdgeSpec = {
  fromStageId: string;
  toStageId: string;
  sourceHandle: "text" | "image" | "video";
  targetHandle: "text" | "image" | "media";
};

/** Repair common LLM mistakes before Zod. */
export function normalizeWorkflowPlanRaw(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const o = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };

  if (out.version === undefined || out.version === null || out.version === "") {
    out.version = 1;
  } else if (typeof out.version === "string") {
    let s = out.version.trim().toLowerCase();
    if (s.startsWith("v")) s = s.slice(1);
    if (s === "1" || s === "1.0") out.version = 1;
  }

  if (!Array.isArray(out.stages)) return out;
  out.stages = out.stages.map((st) => normalizeWorkflowPlanStageRaw(st));
  return out;
}

function normalizeWorkflowPlanStageRaw(st: unknown): unknown {
  if (st === null || typeof st !== "object" || Array.isArray(st)) return st;
  const s: Record<string, unknown> = { ...(st as Record<string, unknown>) };

  if (typeof s.kind === "string") {
    const lower = s.kind.trim().toLowerCase().replace(/[\s_-]+/g, "");
    const kindAliases: Record<string, WorkflowPlan["stages"][number]["kind"]> = {
      mediainput: "textPrimitive",
      mediain: "textPrimitive",
      ingest: "textPrimitive",
      input: "textPrimitive",
      textprimitive: "textPrimitive",
      text: "textPrimitive",
      generation: "generation",
      gen: "generation",
      generate: "generation",
      platformexport: "outputBlock",
      export: "outputBlock",
      platform: "outputBlock",
      output: "outputBlock",
      outputblock: "outputBlock",
      destination: "outputBlock",
      publish: "outputBlock",
    };
    if (kindAliases[lower]) s.kind = kindAliases[lower];
  }

  const kindStr = typeof s.kind === "string" ? s.kind : "";
  if (!["textPrimitive", "generation", "outputBlock"].includes(kindStr)) {
    const t = s.type;
    if (typeof t === "string") {
      const tl = t.trim().toLowerCase().replace(/[\s_-]+/g, "");
      if (tl === "media" || tl === "mediainput") s.kind = "textPrimitive";
      else if (tl === "generation" || tl === "gen") s.kind = "generation";
      else if (tl === "export" || tl === "output") s.kind = "outputBlock";
    }
  }

  if (s.kind === "generation") {
    if (typeof s.outputs === "string" && String(s.outputs).trim()) {
      s.outputs = [String(s.outputs).trim()];
    }
    if (Array.isArray(s.outputs)) {
      const filtered = (s.outputs as unknown[]).filter((x) => x !== "video");
      s.outputs = filtered.length > 0 ? filtered : ["image"];
    }
  }

  if (s.kind === "outputBlock") {
    if (typeof s.mediaFromStageId !== "string" && typeof s.imageFromStageId === "string") {
      s.mediaFromStageId = s.imageFromStageId;
    }
    if (typeof s.sourcePin !== "string" && typeof s.mediaPin === "string") {
      s.sourcePin = s.mediaPin;
    }
  }

  return s;
}

export function safeParseWorkflowPlan(data: unknown) {
  return workflowPlanSchema.safeParse(normalizeWorkflowPlanRaw(data));
}

function uniqueStageIds(stages: WorkflowPlan["stages"]): string[] {
  const ids = stages.map((s) => s.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) {
    throw new GraphError(`Duplicate stage id(s): ${[...new Set(dup)].join(", ")}`);
  }
  return ids;
}

function autoTextFromStorySeed(
  stage: Extract<WorkflowPlan["stages"][number], { kind: "generation" }>,
  inputs: NonNullable<typeof stage.inputs>,
  seedId: string,
): void {
  const outs = new Set(stage.outputs);
  if (inputs.text) return;
  if (outs.has("image") && !inputs.image) {
    inputs.text = { fromStageId: seedId, pin: "text" };
  }
}

function collectEdgeSpecs(plan: WorkflowPlan): EdgeSpec[] {
  const stages = plan.stages;
  uniqueStageIds(stages);

  const seeds = stages.filter((s) => s.kind === "textPrimitive");
  if (seeds.length !== 1) {
    throw new GraphError("Plan must include exactly one textPrimitive seed stage");
  }
  const seedId = seeds[0]!.id;

  const byId = new Map(stages.map((s) => [s.id, s] as const));
  const specs: EdgeSpec[] = [];

  for (const st of stages) {
    if (st.kind !== "generation") continue;
    const inputs: NonNullable<typeof st.inputs> = { ...(st.inputs ?? {}) };
    autoTextFromStorySeed(st, inputs, seedId);

    for (const [targetHandle, pin] of Object.entries(inputs) as [
      keyof typeof inputs,
      { fromStageId: string; pin: "text" | "image" },
    ][]) {
      if (!pin) continue;
      if (!byId.has(pin.fromStageId)) {
        throw new GraphError(`Unknown fromStageId "${pin.fromStageId}" wired into "${st.id}"`);
      }
      specs.push({
        fromStageId: pin.fromStageId,
        toStageId: st.id,
        sourceHandle: pin.pin,
        targetHandle: targetHandle as "text" | "image",
      });
    }

    const outSet = new Set(st.outputs);
    for (const other of stages) {
      if (other.kind !== "generation" && other.kind !== "outputBlock") continue;
      if (other.kind === "generation") {
        const ins = other.inputs ?? {};
        for (const pin of Object.values(ins)) {
          if (pin.fromStageId === st.id && !outSet.has(pin.pin)) {
            throw new GraphError(
              `Stage "${st.id}" declares outputs ${JSON.stringify(st.outputs)} but "${other.id}" expects a ${pin.pin} from it`,
            );
          }
        }
      }
      if (other.kind === "outputBlock") {
        if (other.mediaFromStageId === st.id) {
          const pin = other.sourcePin ?? "image";
          if (pin === "image" && !outSet.has("image")) {
            throw new GraphError(`Generation "${st.id}" must output image for "${other.id}"`);
          }
          if (pin === "text" && !outSet.has("text")) {
            throw new GraphError(`Generation "${st.id}" must output text for "${other.id}"`);
          }
        }
      }
    }
  }

  for (const st of stages) {
    if (st.kind !== "outputBlock") continue;
    const pin = st.sourcePin ?? "image";
    const srcHandle: "text" | "image" | "video" =
      pin === "video" ? "video" : pin === "text" ? "text" : "image";
    specs.push({
      fromStageId: st.mediaFromStageId,
      toStageId: st.id,
      sourceHandle: srcHandle,
      targetHandle: "media",
    });
  }

  const key = (e: EdgeSpec) =>
    `${e.fromStageId}|${e.toStageId}|${e.sourceHandle}|${e.targetHandle}`;
  const seen = new Set<string>();
  const deduped = specs.filter((e) => {
    const k = key(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const genStageIds = new Set<string>();
  for (const st of stages) {
    if (st.kind === "generation") genStageIds.add(st.id);
  }
  const genWithOutbound = new Set<string>();
  for (const e of deduped) {
    if (genStageIds.has(e.fromStageId)) genWithOutbound.add(e.fromStageId);
  }
  for (const id of genStageIds) {
    if (!genWithOutbound.has(id)) {
      throw new GraphError(
        `Generation stage "${id}" has no outgoing wires — connect it to another generation stage or an output preview.`,
      );
    }
  }

  return deduped;
}

export function buildIncomingByTarget(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const m = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = m.get(e.target) ?? [];
    list.push(e);
    m.set(e.target, list);
  }
  return m;
}

export function compileWorkflowPlanToDocument(
  plan: WorkflowPlan,
  ctx: { brief: string },
): { ok: true; document: WorkflowDocument } | { ok: false; message: string } {
  try {
    const edgeSpecs = collectEdgeSpecs(plan);

    const stageIdToNodeId = new Map<string, string>();
    for (const st of plan.stages) {
      stageIdToNodeId.set(st.id, crypto.randomUUID());
    }

    let nodes: WorkflowNode[] = plan.stages.map((st, index) => {
      const id = stageIdToNodeId.get(st.id)!;
      const position = { x: index * 340, y: 0 };

      if (st.kind === "textPrimitive") {
        return {
          id,
          type: "textPrimitive",
          position,
          data: {
            kind: "textPrimitive",
            label: st.label ?? "Story seed",
            purpose: "",
            prompt: "",
            value: ctx.brief.trim(),
            locked: false,
          },
        };
      }

      if (st.kind === "generation") {
        const base = defaultNodeData("generationBlock");
        const merged = {
          ...base,
          label: st.label,
          suffix: st.suffix,
          ...(st.settings ?? {}),
        };
        return {
          id,
          type: "generationBlock",
          position,
          data: merged,
        };
      }

      const base = defaultNodeData("outputBlock");
      return {
        id,
        type: "outputBlock",
        position,
        data: {
          ...base,
          kind: "outputBlock",
          label: st.label ?? base.label,
        },
      };
    });

    const edges: WorkflowEdge[] = edgeSpecs.map((e, i) => ({
      id: `e-${stageIdToNodeId.get(e.fromStageId)}-${stageIdToNodeId.get(e.toStageId)}-${e.sourceHandle}-${e.targetHandle}-${i}`,
      source: stageIdToNodeId.get(e.fromStageId)!,
      target: stageIdToNodeId.get(e.toStageId)!,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    }));

    assertConnectedDAG(nodes, edges);

    const skipImageInference = new Set<string>();
    for (const st of plan.stages) {
      if (st.kind !== "generation") continue;
      if (st.settings?.imageSize !== undefined) {
        skipImageInference.add(stageIdToNodeId.get(st.id)!);
      }
    }
    nodes = reconcileGenerationImageSizes(nodes, edges, {
      skipNodeIds: skipImageInference,
    });

    nodes = layoutWorkflowNodesCompactDAG(nodes, edges);

    const incomingByTarget = buildIncomingByTarget(edges);

    for (const node of nodes) {
      if (node.data.kind !== "generationBlock") continue;
      const inL = incomingMediaLanes(node.id, incomingByTarget);
      const outL = outgoingMediaLanes(node.id, edges);
      planGeneration(inL, outL);
    }

    const doc = {
      id: crypto.randomUUID(),
      name: plan.name.trim().slice(0, 160),
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes,
      edges,
      updatedAt: new Date().toISOString(),
    };

    const validated = workflowDocumentSchema.safeParse(doc);
    if (!validated.success) {
      return {
        ok: false,
        message: `Internal compile error: ${validated.error.issues.map((i) => i.message).join("; ")}`,
      };
    }

    return { ok: true, document: validated.data };
  } catch (err) {
    const message =
      err instanceof GraphError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, message };
  }
}
