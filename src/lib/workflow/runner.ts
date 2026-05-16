import {
  assertConnectedDAG,
  GraphError,
  topologicalOrder,
} from "./graph";
import type { WorkflowEdge, WorkflowNode } from "./schema";

export type RuntimeOutputs = Record<
  string,
  | { type: "text"; value: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string }
  | { type: "bundle"; files: { path: string; blob: Blob }[] }
>;

export type RunProgress = {
  phase: "idle" | "running" | "done" | "error";
  message?: string;
};

type FalTextToImageResponse = {
  image?: { url: string };
  images?: { url: string }[];
};

function collectUpstreamText(
  nodeId: string,
  nodesById: Map<string, WorkflowNode>,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string {
  const incoming = incomingByTarget.get(nodeId) ?? [];
  const parts: string[] = [];
  for (const edge of incoming) {
    const upstream = outputs[edge.source];
    if (!upstream) continue;
    if (upstream.type === "text") parts.push(upstream.value);
  }
  return parts.join("\n").trim();
}

function collectUpstreamImageUrl(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
  outputs: RuntimeOutputs,
): string | undefined {
  const incoming = incomingByTarget.get(nodeId) ?? [];
  for (const edge of incoming) {
    const upstream = outputs[edge.source];
    if (upstream?.type === "image") return upstream.url;
  }
  return undefined;
}

export async function runWorkflowDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: {
    onProgress?: (p: RunProgress) => void;
  } = {},
): Promise<RuntimeOutputs> {
  if (nodes.length === 0) {
    throw new GraphError("Add at least one node before running");
  }

  const { onProgress } = options;
  assertConnectedDAG(nodes, edges);
  const order = topologicalOrder(nodes, edges);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const list = incomingByTarget.get(e.target) ?? [];
    list.push(e);
    incomingByTarget.set(e.target, list);
  }

  const outputs: RuntimeOutputs = {};

  onProgress?.({ phase: "running", message: "Executing workflow…" });

  for (const id of order) {
    const node = nodesById.get(id)!;
    const data = node.data;

    switch (data.kind) {
      case "textInput":
        outputs[id] = { type: "text", value: data.value };
        break;
      case "imageInput": {
        const url = data.dataUrl;
        if (!url) {
          throw new GraphError(`Image input “${data.label}” is empty — upload a file`);
        }
        outputs[id] = { type: "image", url };
        break;
      }
      case "videoInput": {
        const url = data.dataUrl;
        if (!url) {
          throw new GraphError(`Video input “${data.label}” is empty — upload a file`);
        }
        outputs[id] = { type: "video", url };
        break;
      }
      case "falFluxSchnell": {
        const prompt =
          collectUpstreamText(id, nodesById, incomingByTarget, outputs) + data.suffix;
        if (!prompt.trim()) {
          throw new GraphError("Flux Schnell needs upstream text");
        }
        const res = await fetch("/api/fal/text-to-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            imageSize: data.imageSize,
            numInferenceSteps: data.numInferenceSteps,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new GraphError(
            typeof err?.error === "string" ? err.error : `Fal request failed (${res.status})`,
          );
        }
        const body = (await res.json()) as FalTextToImageResponse;
        const url = body.image?.url ?? body.images?.[0]?.url;
        if (!url) throw new GraphError("Fal response missing image URL");
        outputs[id] = { type: "image", url };
        break;
      }
      case "platformExport": {
        const imageUrl = collectUpstreamImageUrl(id, incomingByTarget, outputs);
        const copy = collectUpstreamText(id, nodesById, incomingByTarget, outputs);
        if (!imageUrl) {
          throw new GraphError(
            `Platform export (${data.platform}) requires an upstream image`,
          );
        }
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) throw new GraphError("Failed to download image for export");
        const blob = await imgRes.blob();
        const manifest = {
          platform: data.platform,
          title: data.label,
          copy,
          generatedAt: new Date().toISOString(),
          sourceImage: imageUrl,
        };
        const files: { path: string; blob: Blob }[] = [
          {
            path: `platforms/${data.platform}/creative.png`,
            blob,
          },
          {
            path: `platforms/${data.platform}/manifest.json`,
            blob: new Blob([JSON.stringify(manifest, null, 2)], {
              type: "application/json",
            }),
          },
        ];
        outputs[id] = { type: "bundle", files };
        break;
      }
      default: {
        const _never: never = data;
        return _never;
      }
    }
  }

  onProgress?.({ phase: "done" });
  return outputs;
}

export function wrapError(e: unknown): GraphError {
  if (e instanceof GraphError) return e;
  if (e instanceof Error) return new GraphError(e.message);
  return new GraphError("Unknown error");
}
