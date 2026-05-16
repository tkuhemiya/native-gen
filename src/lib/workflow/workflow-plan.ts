import { falFluxPresetSizeSchema } from "@/lib/fal/text-to-image-config";
import { z } from "zod";

import { assertConnectedDAG, GraphError } from "./graph";
import { incomingMediaLanes, outgoingMediaLanes, planGeneration } from "./generation-plan";
import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

const modalitySchema = z.enum(["text", "image", "video"]);

const stageInputPinSchema = z.object({
  fromStageId: z.string().min(1),
  pin: modalitySchema,
});

const generationSettingsSchema = z.object({
  imageSize: falFluxPresetSizeSchema.optional(),
  numInferenceSteps: z.number().int().min(1).max(12).optional(),
  videoDuration: z.enum(["4s", "6s", "8s"]).optional(),
  videoResolution: z.enum(["720p", "1080p"]).optional(),
  videoSilent: z.boolean().optional(),
  wanDurationSec: z.number().int().min(2).max(15).optional(),
  wanResolution: z.enum(["720p", "1080p"]).optional(),
});

const planMediaStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("mediaInput"),
  label: z.string().optional(),
});

const planGenerationStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("generation"),
  label: z.string().min(1),
  /** Appended by the runner to upstream text; keep look vs motion split here. */
  suffix: z.string(),
  /** What this block outputs (declares pins). Must match how downstream stages reference this block. */
  outputs: z.array(modalitySchema).min(1),
  /**
   * Incoming wires: target pin on THIS block -> where it comes from.
   * Omit keys the block does not need; compiler may add `text` from `mediaInput` when obvious.
   */
  inputs: z.record(modalitySchema, stageInputPinSchema).optional(),
  settings: generationSettingsSchema.optional(),
});

const planExportStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("platformExport"),
  label: z.string().optional(),
  platform: z.enum(["youtube", "facebook", "instagram", "tiktok"]),
  /** Default: mediaInput stage id if omitted and a single mediaInput exists */
  copyFromStageId: z.string().optional(),
  /** Primary image source for export (also use moreImageFromStageIds for extra wired images). */
  imageFromStageId: z.string().optional(),
  /**
   * Additional generation stages (each must output image) wired into the same export image pin.
   * Use for multi-subject carousels / grids so each block stays editable on the canvas.
   */
  moreImageFromStageIds: z.array(z.string().min(1)).optional(),
  videoFromStageId: z.string().optional(),
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
        planMediaStageSchema,
        planGenerationStageSchema,
        planExportStageSchema,
      ]),
    )
    .min(2),
});

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

/**
 * Repair common LLM mistakes before Zod (wrong kind casing, platform: "copy", string outputs, missing version).
 */
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
    const kindAliases: Record<string, "mediaInput" | "generation" | "platformExport"> = {
      mediainput: "mediaInput",
      mediain: "mediaInput",
      mediaingest: "mediaInput",
      ingest: "mediaInput",
      input: "mediaInput",
      campaigninput: "mediaInput",
      generation: "generation",
      gen: "generation",
      generate: "generation",
      generator: "generation",
      diffusion: "generation",
      imagegen: "generation",
      platformexport: "platformExport",
      export: "platformExport",
      platform: "platformExport",
      output: "platformExport",
      destination: "platformExport",
      publish: "platformExport",
    };
    if (kindAliases[lower]) s.kind = kindAliases[lower];
  }

  const kindStr = typeof s.kind === "string" ? s.kind : "";
  if (!["mediaInput", "generation", "platformExport"].includes(kindStr)) {
    const t = s.type;
    if (typeof t === "string") {
      const tl = t.trim().toLowerCase().replace(/[\s_-]+/g, "");
      if (tl === "media" || tl === "mediainput") s.kind = "mediaInput";
      else if (tl === "generation" || tl === "gen") s.kind = "generation";
      else if (tl === "export" || tl === "output" || tl === "platformexport") s.kind = "platformExport";
    }
  }

  if (s.kind === "generation") {
    if (typeof s.outputs === "string" && s.outputs.trim()) {
      s.outputs = [s.outputs.trim()];
    }
  }

  if (s.kind === "platformExport" && typeof s.platform === "string") {
    const pl = s.platform.trim().toLowerCase();
    const fixPlatform: Record<string, "youtube" | "facebook" | "instagram" | "tiktok"> = {
      ig: "instagram",
      insta: "instagram",
      instagram: "instagram",
      fb: "facebook",
      facebook: "facebook",
      meta: "facebook",
      yt: "youtube",
      youtube: "youtube",
      tiktok: "tiktok",
      tt: "tiktok",
    };
    if (fixPlatform[pl]) {
      s.platform = fixPlatform[pl];
    } else if (pl === "copy" || pl === "caption" || pl === "text" || pl === "description") {
      s.platform = "instagram";
      if (typeof s.copyFromStageId !== "string" || !String(s.copyFromStageId).trim()) {
        s.copyFromStageId = "media";
      }
    }
  }

  if (s.kind === "platformExport" && s.moreImageFromStageIds != null && !Array.isArray(s.moreImageFromStageIds)) {
    if (typeof s.moreImageFromStageIds === "string" && s.moreImageFromStageIds.trim()) {
      s.moreImageFromStageIds = [s.moreImageFromStageIds.trim()];
    }
  }

  return s;
}

export function safeParseWorkflowPlan(data: unknown) {
  return workflowPlanSchema.safeParse(normalizeWorkflowPlanRaw(data));
}

type EdgeSpec = {
  fromStageId: string;
  toStageId: string;
  sourceHandle: "text" | "image" | "video";
  targetHandle: "text" | "image" | "video";
};

function uniqueStageIds(stages: WorkflowPlan["stages"]): string[] {
  const ids = stages.map((s) => s.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) {
    throw new GraphError(`Duplicate stage id(s): ${[...new Set(dup)].join(", ")}`);
  }
  return ids;
}

/**
 * Infer missing `text` input from the sole mediaInput when the generation block needs upstream copy
 * (text→image, text→video, or image→video plus optional brief on the text pin).
 */
function autoTextFromMedia(
  stage: Extract<WorkflowPlan["stages"][number], { kind: "generation" }>,
  inputs: NonNullable<typeof stage.inputs>,
  mediaStageId: string,
): void {
  const outs = new Set(stage.outputs);
  if (inputs.text) return;

  /* t2i */
  if (outs.has("image") && !outs.has("video") && !inputs.image && !inputs.video) {
    inputs.text = { fromStageId: mediaStageId, pin: "text" };
    return;
  }
  /* t2v (no image/video in) */
  if (outs.has("video") && !inputs.image && !inputs.video) {
    inputs.text = { fromStageId: mediaStageId, pin: "text" };
    return;
  }
  /* i2v: add brief on text pin when image comes from upstream */
  if (outs.has("video") && inputs.image && !inputs.text) {
    inputs.text = { fromStageId: mediaStageId, pin: "text" };
  }
}

function collectEdgeSpecs(plan: WorkflowPlan): EdgeSpec[] {
  const stages = plan.stages;
  uniqueStageIds(stages);

  const mediaStages = stages.filter((s) => s.kind === "mediaInput");
  if (mediaStages.length !== 1) {
    throw new GraphError("Plan must include exactly one mediaInput stage");
  }
  const mediaStageId = mediaStages[0]!.id;

  const byId = new Map(stages.map((s) => [s.id, s] as const));

  const specs: EdgeSpec[] = [];

  for (const st of stages) {
    if (st.kind !== "generation") continue;

    const inputs: NonNullable<typeof st.inputs> = { ...(st.inputs ?? {}) };
    autoTextFromMedia(st, inputs, mediaStageId);

    for (const [targetHandle, pin] of Object.entries(inputs) as [
      keyof typeof inputs,
      { fromStageId: string; pin: "text" | "image" | "video" },
    ][]) {
      if (!pin) continue;
      if (!byId.has(pin.fromStageId)) {
        throw new GraphError(`Unknown fromStageId "${pin.fromStageId}" wired into "${st.id}"`);
      }
      specs.push({
        fromStageId: pin.fromStageId,
        toStageId: st.id,
        sourceHandle: pin.pin,
        targetHandle: targetHandle as "text" | "image" | "video",
      });
    }

    /* Validate declared outputs cover what downstream expects — light check */
    const outSet = new Set(st.outputs);
    for (const other of stages) {
      if (other.kind !== "generation" && other.kind !== "platformExport") continue;
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
      if (other.kind === "platformExport") {
        const imageRefs = [
          ...(other.imageFromStageId ? [other.imageFromStageId] : []),
          ...(other.moreImageFromStageIds ?? []),
        ];
        for (const refId of imageRefs) {
          if (refId === st.id && !outSet.has("image")) {
            throw new GraphError(
              `Stage "${st.id}" must list "image" in outputs because export references it for images`,
            );
          }
        }
        if (other.videoFromStageId === st.id && !outSet.has("video")) {
          throw new GraphError(
            `Stage "${st.id}" must list "video" in outputs because export uses it as videoFromStageId`,
          );
        }
      }
    }
  }

  for (const st of stages) {
    if (st.kind !== "platformExport") continue;

    const copyId = st.copyFromStageId ?? mediaStageId;
    if (!byId.has(copyId)) {
      throw new GraphError(`Unknown copyFromStageId "${copyId}"`);
    }
    specs.push({
      fromStageId: copyId,
      toStageId: st.id,
      sourceHandle: "text",
      targetHandle: "text",
    });

    const imageStageIds = [
      ...(st.imageFromStageId ? [st.imageFromStageId] : []),
      ...(st.moreImageFromStageIds ?? []),
    ];
    const seenImgStages = new Set<string>();
    for (const imgId of imageStageIds) {
      if (seenImgStages.has(imgId)) continue;
      seenImgStages.add(imgId);
      if (!byId.has(imgId)) {
        throw new GraphError(`Unknown image stage id "${imgId}"`);
      }
      specs.push({
        fromStageId: imgId,
        toStageId: st.id,
        sourceHandle: "image",
        targetHandle: "image",
      });
    }

    if (st.videoFromStageId) {
      if (!byId.has(st.videoFromStageId)) {
        throw new GraphError(`Unknown videoFromStageId "${st.videoFromStageId}"`);
      }
      specs.push({
        fromStageId: st.videoFromStageId,
        toStageId: st.id,
        sourceHandle: "video",
        targetHandle: "video",
      });
    }
  }

  /* Dedupe identical specs */
  const key = (e: EdgeSpec) =>
    `${e.fromStageId}|${e.toStageId}|${e.sourceHandle}|${e.targetHandle}`;
  const seen = new Set<string>();
  return specs.filter((e) => {
    const k = key(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

/**
 * Turn a high-level plan (ordered stages + modality wiring) into a persisted workflow document.
 * Fills `generationBlock` defaults; the model only supplies labels, suffixes, wiring, and optional settings.
 */
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

    const nodes: WorkflowNode[] = plan.stages.map((st, index) => {
      const id = stageIdToNodeId.get(st.id)!;
      const position = { x: index * 340, y: 0 };

      if (st.kind === "mediaInput") {
        return {
          id,
          type: "mediaInput",
          position,
          data: {
            kind: "mediaInput",
            label: st.label ?? "Campaign input",
            value: ctx.brief.trim(),
            images: [],
            videos: [],
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

      const base = defaultNodeData("platformExport");
      return {
        id,
        type: "platformExport",
        position,
        data: {
          ...base,
          kind: "platformExport",
          label: st.label ?? base.label,
          platform: st.platform,
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
