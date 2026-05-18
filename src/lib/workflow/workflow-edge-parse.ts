import type { WorkflowEdge } from "./schema";

/** Best-effort parse of `doc.edges` from unknown persisted JSON before Zod validation. */
export function parseWorkflowEdgesLoose(rawEdges: unknown): WorkflowEdge[] {
  if (!Array.isArray(rawEdges)) return [];
  const out: WorkflowEdge[] = [];
  for (const e of rawEdges) {
    if (e === null || typeof e !== "object") continue;
    const edge = e as Record<string, unknown>;
    const source = typeof edge.source === "string" ? edge.source : "";
    const target = typeof edge.target === "string" ? edge.target : "";
    if (!source || !target) continue;
    out.push({
      id: String(edge.id ?? crypto.randomUUID()),
      source,
      target,
      sourceHandle:
        edge.sourceHandle === undefined ? undefined : (edge.sourceHandle as string | null),
      targetHandle:
        edge.targetHandle === undefined ? undefined : (edge.targetHandle as string | null),
    });
  }
  return out;
}

