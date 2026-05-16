import { buildYoutubeLookRefThenVideoTemplate } from "./template-from-brief";
import { assertConnectedDAG, GraphError } from "./graph";
import {
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
} from "./generation-plan";
import { layoutWorkflowNodesCompactDAG } from "./node-layout";
import { normalizeWorkflowDocument } from "./migrate";
import {
  WORKFLOW_DOCUMENT_VERSION,
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowNode,
} from "./schema";
import { buildIncomingByTarget } from "./workflow-plan";
import type { ZodError } from "zod";

function linesFromZodError(err: ZodError): string[] {
  return err.issues.map((i) => {
    const p = i.path.length ? i.path.join(".") : "root";
    return `${p}: ${i.message}`;
  });
}

export type WorkflowValidationFailure = {
  ok: false;
  /** Short headline for logs */
  error: string;
  /** One line per issue (schema, graph, etc.) */
  issues: string[];
};

/** Brief heuristics for YouTube look-ref template (mirrors workflow-agent). */
export function briefSuggestsLookRefPipeline(brief: string): boolean {
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

/**
 * Snapshot for prompts / read_workflow: drop heavy data URLs so the model sees structure without multi-MB payloads.
 */
export function stripWorkflowMediaForAgent(doc: WorkflowDocument): WorkflowDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.data.kind !== "mediaInput") return n;
      return {
        ...n,
        data: { ...n.data, images: [], videos: [] },
      };
    }),
  };
}

/** If the model returns empty media arrays for an existing mediaInput id, keep user uploads from the prior canvas. */
export function mergePreservedMediaFromPrevious(
  doc: WorkflowDocument,
  previous: WorkflowDocument | null,
): WorkflowDocument {
  if (!previous) return doc;
  const prevById = new Map(previous.nodes.map((n) => [n.id, n]));
  const nodes: WorkflowNode[] = doc.nodes.map((n) => {
    if (n.data.kind !== "mediaInput") return n;
    const prev = prevById.get(n.id);
    if (!prev || prev.data.kind !== "mediaInput") return n;
    const emptyNew = n.data.images.length === 0 && n.data.videos.length === 0;
    const hadPrev = prev.data.images.length > 0 || prev.data.videos.length > 0;
    if (emptyNew && hadPrev) {
      return {
        ...n,
        data: {
          ...n.data,
          images: prev.data.images,
          videos: prev.data.videos,
        },
      };
    }
    return n;
  });
  return { ...doc, nodes };
}

/**
 * Parse model-written workflow JSON, validate graph + generation pins, merge preserved media, layout, optional YouTube template.
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
    const incomingByTarget = buildIncomingByTarget(doc.edges);
    for (const node of doc.nodes) {
      if (node.data.kind !== "generationBlock") continue;
      const inL = incomingMediaLanes(node.id, incomingByTarget);
      const outL = outgoingMediaLanes(node.id, doc.edges);
      planGeneration(inL, outL);
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

  let out = doc;
  if (isSingleGenYoutubeVideoExport(out) && briefSuggestsLookRefPipeline(ctx.brief)) {
    out = buildYoutubeLookRefThenVideoTemplate(ctx.brief, "youtube");
  }

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
