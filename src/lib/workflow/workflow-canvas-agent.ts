import {
  assertConnectedDAG,
  assertSceneJoinClipWiring,
  buildIncomingByTarget,
  GraphError,
} from "./graph";
import {
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
} from "./generation-plan";
import { layoutWorkflowNodesCompactDAG } from "./node-layout";
import { normalizeWorkflowDocument } from "./migrate";
import { reconcileGenerationImageSizes } from "./platform-aspect-presets";
import {
  WORKFLOW_DOCUMENT_VERSION,
  workflowDocumentSchema,
  type NodeData,
  type StoredImageAsset,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";
import type { ZodError } from "zod";

function linesFromZodError(err: ZodError): string[] {
  return err.issues.map((i) => {
    const p = i.path.length ? i.path.join(".") : "root";
    return `${p}: ${i.message}`;
  });
}

export type WorkflowValidationFailure = {
  ok: false;
  error: string;
  issues: string[];
};

const COMPOSER_REF_PROMPT_TAG =
  "[reference still attached on canvas — wire image out → generationBlock / videoBlock image in]";

/** Snapshot for prompts / read_workflow: drop heavy data URLs so the model sees structure without multi-MB payloads. */
export function stripWorkflowMediaForAgent(doc: WorkflowDocument): WorkflowDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.data.kind !== "imagePrimitive") return n;
      const hasRef = Boolean(n.data.image?.dataUrl?.trim());
      const prompt = n.data.prompt.includes(COMPOSER_REF_PROMPT_TAG)
        ? n.data.prompt
        : hasRef
          ? [n.data.prompt.trim(), COMPOSER_REF_PROMPT_TAG].filter(Boolean).join("\n")
          : n.data.prompt;
      return {
        ...n,
        data: {
          ...n.data,
          prompt,
          image: undefined,
        },
      };
    }),
  };
}

/** Markdown hint listing image primitives that already carry composer reference stills. */
export function buildComposerReferenceHintForAgent(
  doc: WorkflowDocument | null,
): string {
  if (!doc) return "";
  const refs = doc.nodes.filter(
    (n) => n.data.kind === "imagePrimitive" && n.data.image?.dataUrl?.trim(),
  );
  if (!refs.length) return "";
  const lines = refs.map(
    (n) =>
      `- \`${n.id}\` · **${n.data.label}** — reference still is on canvas; wire **image** out → downstream **image** in`,
  );
  return `\n\n## Attached reference stills (on canvas before you write)\n${lines.join("\n")}\n**Preserve these node ids** and \`locked\` \`imagePrimitive\` nodes when expanding the graph; fan stills / video from them.`;
}

/** Seed canvas when the user attaches images but there is no workflow yet. */
export function buildComposerReferenceSeedDocument(
  assets: StoredImageAsset[],
): WorkflowDocument {
  const safe = assets.filter(
    (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
  );
  const nodes: WorkflowNode[] = safe.map((a, i) => {
    const data: Extract<NodeData, { kind: "imagePrimitive" }> = {
      kind: "imagePrimitive",
      label: referenceLabelFromAsset(a, i),
      prompt: COMPOSER_REF_PROMPT_TAG,
      locked: true,
      image: { dataUrl: a.dataUrl, fileName: a.fileName },
    };
    return {
      id: crypto.randomUUID(),
      type: "imagePrimitive",
      position: { x: 0, y: i * 300 },
      data,
    };
  });
  const doc = {
    id: crypto.randomUUID(),
    name: "Reference imports",
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges: [] as WorkflowEdge[],
    updatedAt: new Date().toISOString(),
  };
  const parsed = workflowDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error("Composer reference seed failed validation");
  }
  return parsed.data;
}

/**
 * Put composer images on the canvas **before** the agent reads/wires the graph.
 */
export function ensureComposerReferencesOnCanvas(
  canvas: WorkflowDocument | null,
  assets: StoredImageAsset[],
): WorkflowDocument | null {
  const safe = assets.filter(
    (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
  );
  if (!safe.length) return canvas;
  if (!canvas) return buildComposerReferenceSeedDocument(safe);
  return mergeComposerImagesIntoPrimaryImagePrimitive(canvas, safe, {
    autoWire: false,
    layout: true,
  });
}

/** Keep uploaded stills when the model omits `image` on an existing image primitive id. */
export function mergePreservedMediaFromPrevious(
  doc: WorkflowDocument,
  previous: WorkflowDocument | null,
): WorkflowDocument {
  if (!previous) return doc;
  const prevById = new Map(previous.nodes.map((n) => [n.id, n]));
  const nodes: WorkflowNode[] = doc.nodes.map((n) => {
    if (n.data.kind !== "imagePrimitive") return n;
    const prev = prevById.get(n.id);
    if (!prev || prev.data.kind !== "imagePrimitive") return n;
    const emptyNew = !n.data.image?.dataUrl;
    const hadPrev = !!prev.data.image?.dataUrl;
    if (emptyNew && hadPrev && prev.data.image) {
      return {
        ...n,
        data: {
          ...n.data,
          image: prev.data.image,
        },
      };
    }
    return n;
  });
  return { ...doc, nodes };
}

function referenceLabelFromAsset(asset: StoredImageAsset, index: number): string {
  const base = asset.fileName?.replace(/\.[^.]+$/i, "").trim();
  if (base) return base.slice(0, 80);
  return `Reference ${index + 1}`;
}

function imagePrimitiveHasOutgoingImageWire(
  nodeId: string,
  edges: WorkflowEdge[],
): boolean {
  return edges.some(
    (e) =>
      e.source === nodeId &&
      (e.sourceHandle === "image" || e.sourceHandle == null),
  );
}

/** Generation / video blocks that accept a blue image pin but do not have one yet. */
function targetsNeedingReferenceImage(
  doc: WorkflowDocument,
  incomingByTarget: Map<string, WorkflowEdge[]>,
): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  for (const node of doc.nodes) {
    if (node.data.kind === "generationBlock") {
      const inL = incomingMediaLanes(node.id, incomingByTarget);
      if (!inL.image) out.push(node);
      continue;
    }
    if (node.data.kind === "videoBlock") {
      const incoming = incomingByTarget.get(node.id) ?? [];
      const hasImageIn = incoming.some(
        (e) => e.targetHandle === "image" || e.targetHandle == null,
      );
      if (!hasImageIn) out.push(node);
    }
  }
  return out;
}

/** Wire unattached reference stills into producers that lack an image input. */
function autoWireComposerReferenceImages(doc: WorkflowDocument): WorkflowDocument {
  let edges = [...doc.edges];
  let incomingByTarget = buildIncomingByTarget(edges);

  const refs = doc.nodes.filter((n) => {
    if (n.data.kind !== "imagePrimitive") return false;
    if (!n.data.image?.dataUrl?.trim()) return false;
    return !imagePrimitiveHasOutgoingImageWire(n.id, edges);
  });

  if (!refs.length) return doc;

  const targets = targetsNeedingReferenceImage(doc, incomingByTarget);
  const pairCount = Math.min(refs.length, targets.length);

  for (let i = 0; i < pairCount; i += 1) {
    const ref = refs[i]!;
    const target = targets[i]!;
    const edgeId = `e-composer-ref-${ref.id.slice(0, 8)}-${target.id.slice(0, 8)}`;
    if (edges.some((e) => e.id === edgeId)) continue;
    edges = [
      ...edges,
      {
        id: edgeId,
        source: ref.id,
        target: target.id,
        sourceHandle: "image",
        targetHandle: "image",
      },
    ];
    incomingByTarget = buildIncomingByTarget(edges);
  }

  const fallbackTarget =
    doc.nodes.find((n) => n.data.kind === "generationBlock") ??
    doc.nodes.find((n) => n.data.kind === "videoBlock");

  if (fallbackTarget) {
    for (const ref of refs) {
      if (imagePrimitiveHasOutgoingImageWire(ref.id, edges)) continue;
      const edgeId = `e-composer-ref-fallback-${ref.id.slice(0, 8)}-${fallbackTarget.id.slice(0, 8)}`;
      if (edges.some((e) => e.id === edgeId)) continue;
      edges = [
        ...edges,
        {
          id: edgeId,
          source: ref.id,
          target: fallbackTarget.id,
          sourceHandle: "image",
          targetHandle: "image",
        },
      ];
    }
  }

  return { ...doc, edges };
}

/**
 * Places composer-attached stills on the canvas: fills empty `imagePrimitive` nodes,
 * creates new reference primitives for any leftovers, auto-wires to generation/video
 * blocks when possible, then re-layouts.
 */
export type MergeComposerImagesOptions = {
  /** When false, only place stills on image primitives (agent wires). Default true. */
  autoWire?: boolean;
  layout?: boolean;
};

export function mergeComposerImagesIntoPrimaryImagePrimitive(
  doc: WorkflowDocument,
  assets: StoredImageAsset[],
  options: MergeComposerImagesOptions = {},
): WorkflowDocument {
  const { autoWire = true, layout = true } = options;
  const safe = assets.filter(
    (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
  );
  if (!safe.length) return doc;

  let placed = 0;
  let nodes: WorkflowNode[] = doc.nodes.map((n) => {
    if (n.data.kind !== "imagePrimitive" || placed >= safe.length) return n;
    if (n.data.image?.dataUrl) return n;
    const a = safe[placed]!;
    placed += 1;
    return {
      ...n,
      data: {
        ...n.data,
        image: { dataUrl: a.dataUrl, fileName: a.fileName },
        locked: n.data.locked || true,
      },
    };
  });

  const remaining = safe.slice(placed);
  const edges: WorkflowEdge[] = [...doc.edges];

  if (remaining.length > 0) {
    const minX = nodes.length
      ? Math.min(...nodes.map((n) => n.position.x))
      : 0;
    const spawnX = minX - 360;
    let spawnY = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      const a = remaining[i]!;
      const nodeId = crypto.randomUUID();
      const data: Extract<NodeData, { kind: "imagePrimitive" }> = {
        kind: "imagePrimitive",
        label: referenceLabelFromAsset(a, placed + i),
        prompt: COMPOSER_REF_PROMPT_TAG,
        locked: true,
        image: { dataUrl: a.dataUrl, fileName: a.fileName },
      };
      const newNode: WorkflowNode = {
        id: nodeId,
        type: "imagePrimitive",
        position: { x: spawnX, y: spawnY },
        data,
      };
      nodes = [...nodes, newNode];
      spawnY += 300;
    }
  }

  let out: WorkflowDocument = {
    ...doc,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };

  if (autoWire) {
    out = autoWireComposerReferenceImages(out);
  }
  if (layout) {
    out = {
      ...out,
      nodes: layoutWorkflowNodesCompactDAG(out.nodes, out.edges),
      updatedAt: new Date().toISOString(),
    };
  }

  return out;
}

/**
 * Parse model-written workflow JSON, validate graph + generation pins, merge preserved media, layout.
 */
export function validateAndFinalizeWorkflowWrite(
  workflowJson: string,
  ctx: { brief: string; previousCanvas: WorkflowDocument | null },
):
  | { ok: true; document: WorkflowDocument }
  | WorkflowValidationFailure {
  let raw: unknown;
  try {
    raw = JSON.parse(workflowJson) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid JSON: ${msg}`, issues: [`json.parse: ${msg}`] };
  }

  let doc = normalizeWorkflowDocument(raw);
  if (!doc) {
    const parsed = workflowDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = linesFromZodError(parsed.error);
      return {
        ok: false,
        error: issues.length ? issues[0]! : "Workflow document failed schema validation",
        issues: issues.length ? issues : ["root: workflow document failed schema validation"],
      };
    }
    doc = parsed.data;
  }

  if (doc.version !== WORKFLOW_DOCUMENT_VERSION) {
    const line = `version: must be ${WORKFLOW_DOCUMENT_VERSION} (got ${String(doc.version)})`;
    return {
      ok: false,
      error: `Workflow ${line}`,
      issues: [line],
    };
  }

  doc = mergePreservedMediaFromPrevious(doc, ctx.previousCanvas);
  doc = {
    ...doc,
    updatedAt: new Date().toISOString(),
  };

  try {
    assertConnectedDAG(doc.nodes, doc.edges);
    assertSceneJoinClipWiring(doc.nodes, doc.edges);
    const incomingByTarget = buildIncomingByTarget(doc.edges);
    for (const node of doc.nodes) {
      if (node.data.kind === "generationBlock") {
        const inL = incomingMediaLanes(node.id, incomingByTarget);
        const outL = outgoingMediaLanes(node.id, doc.edges);
        planGeneration(inL, outL);
        continue;
      }
      if (node.data.kind === "videoBlock") {
        const incoming = incomingByTarget.get(node.id) ?? [];
        const hasImageIn = incoming.some(
          (e) => e.targetHandle === "image" || e.targetHandle == null,
        );
        if (!hasImageIn) {
          throw new GraphError(
            `Video block "${node.data.label || node.id}" needs an upstream still wired to its blue image pin.`,
          );
        }
      }
    }
  } catch (e) {
    const message =
      e instanceof GraphError ? e.message : e instanceof Error ? e.message : String(e);
    const lines = message
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ok: false,
      error: message,
      issues: lines.length ? lines : [message],
    };
  }

  doc = {
    ...doc,
    nodes: reconcileGenerationImageSizes(doc.nodes, doc.edges),
  };

  let out = doc;

  const laidOutNodes = layoutWorkflowNodesCompactDAG(out.nodes, out.edges);
  out = { ...out, nodes: laidOutNodes };

  const finalCheck = workflowDocumentSchema.safeParse(out);
  if (!finalCheck.success) {
    const issues = linesFromZodError(finalCheck.error);
    return {
      ok: false,
      error: issues.length ? issues[0]! : "Workflow failed schema validation after layout",
      issues: issues.length ? issues : ["root: validation failed after layout"],
    };
  }

  return { ok: true, document: finalCheck.data };
}
