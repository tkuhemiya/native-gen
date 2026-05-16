import { assertConnectedDAG, GraphError } from "./graph";
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
  type MediaInputAsset,
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
        data: { ...n.data, images: [] },
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
    const emptyNew = n.data.images.length === 0;
    const hadPrev = prev.data.images.length > 0;
    if (emptyNew && hadPrev) {
      return {
        ...n,
        data: {
          ...n.data,
          images: prev.data.images,
        },
      };
    }
    return n;
  });
  return { ...doc, nodes };
}

/**
 * Prepends images pasted/attached from the workflow chat onto the primary `mediaInput`
 * (top-left-ish hub). Safe for empty arrays; skips non-image data URLs.
 */
export function mergeComposerImagesIntoPrimaryMediaInput(
  doc: WorkflowDocument,
  assets: MediaInputAsset[],
): WorkflowDocument {
  const safe = assets.filter(
    (a) => typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"),
  );
  if (!safe.length) return doc;

  const mediaNodes = doc.nodes.filter((n) => n.data.kind === "mediaInput");
  if (!mediaNodes.length) return doc;

  const primary = [...mediaNodes].sort((a, b) => {
    const dy = a.position.y - b.position.y;
    if (Math.abs(dy) > 24) return dy;
    return a.position.x - b.position.x;
  })[0]!;

  const nodes = doc.nodes.map((n) => {
    if (n.id !== primary.id || n.data.kind !== "mediaInput") return n;
    const prepend = safe.map(({ dataUrl, fileName }) => ({ dataUrl, fileName }));
    return {
      ...n,
      data: {
        ...n.data,
        images: [...prepend, ...n.data.images],
      },
    };
  });

  return { ...doc, nodes, updatedAt: new Date().toISOString() };
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
