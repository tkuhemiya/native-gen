import { parseWorkflowEdgesLoose } from "./workflow-edge-parse";

function sanitizeSceneJoinTransitions(raw: unknown): { mode: "cut" | "bridge"; bridgePrompt?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { mode: "cut" | "bridge"; bridgePrompt?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const mode = rec.mode === "bridge" ? ("bridge" as const) : ("cut" as const);
    const bp = rec.bridgePrompt;
    const bridgePrompt = typeof bp === "string" && bp.trim() ? bp.trim() : undefined;
    out.push(mode === "bridge" ? { mode: "bridge", bridgePrompt } : { mode: "cut" });
  }
  return out;
}

/** Strip legacy `orderedClipNodeIds` and add clip→join edges so v7 validates. */
export function migrateSceneJoinClipListToEdges(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const doc = raw as Record<string, unknown>;
  const nodes = doc.nodes;
  if (!Array.isArray(nodes)) return doc;

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    if (id) nodeById.set(id, n);
  }

  const edges = parseWorkflowEdgesLoose(doc.edges);

  const edgeDup = new Set(
    edges.map((e) => `${e.source}|${e.target}|${e.sourceHandle ?? ""}|${e.targetHandle ?? ""}`),
  );

  const nextNodes = nodes.map((node) => {
    if (node === null || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const data = n.data;
    if (data === null || typeof data !== "object") return node;
    const d = data as Record<string, unknown>;
    if (d.kind !== "sceneJoin") return node;

    const joinId = typeof n.id === "string" ? n.id : "";
    const legacyIds = d.orderedClipNodeIds;

    if (Array.isArray(legacyIds) && joinId) {
      for (const cid of legacyIds) {
        if (typeof cid !== "string" || !cid.trim()) continue;
        const srcNode = nodeById.get(cid);
        const srcData =
          srcNode?.data !== null && typeof srcNode?.data === "object"
            ? (srcNode!.data as Record<string, unknown>)
            : null;
        if (srcData?.kind !== "videoBlock") continue;

        const key = `${cid}|${joinId}|video|clips`;
        if (!edgeDup.has(key)) {
          edges.push({
            id: crypto.randomUUID(),
            source: cid,
            target: joinId,
            sourceHandle: "video",
            targetHandle: "clips",
          });
          edgeDup.add(key);
        }
      }
    }

    const transitions = sanitizeSceneJoinTransitions(d.transitions);

    return {
      ...n,
      type: "sceneJoin",
      data: {
        kind: "sceneJoin",
        label: typeof d.label === "string" ? d.label : "Join scenes",
        transitions,
      },
    };
  });

  return { ...doc, nodes: nextNodes, edges };
}
