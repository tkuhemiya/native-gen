import { GraphError } from "./graph";
import type { WorkflowEdge } from "./schema";

export type MediaLanes = {
  text: boolean;
  image: boolean;
};

/** Incoming edges hitting this generation node (by target handle). */
export function incomingMediaLanes(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
): MediaLanes {
  const lanes = { text: false, image: false };
  for (const edge of incomingByTarget.get(nodeId) ?? []) {
    const th = edge.targetHandle ?? null;
    if (th === "image") lanes.image = true;
    else lanes.text = true;
  }
  return lanes;
}

/** Downstream pulls by source handle from this generation node. */
export function outgoingMediaLanes(nodeId: string, edges: WorkflowEdge[]): MediaLanes {
  const lanes = { text: false, image: false };
  for (const e of edges) {
    if (e.source !== nodeId) continue;
    const sh = e.sourceHandle ?? null;
    if (sh === "text") lanes.text = true;
    else lanes.image = true;
  }
  return lanes;
}

export type GenerationPlan = {
  /** Echo upstream copy (+ node suffix already blended into promptBase by runner). */
  needPassthroughText: boolean;
  /** fal-ai/florence-2-large/caption — optional merge with upstream text notes */
  needCaption: boolean;
  needTextToImage: boolean;
};

/**
 * Decide which fal jobs to run from wired pins. Raises {@link GraphError} when pins disagree.
 */
export function planGeneration(inL: MediaLanes, outL: MediaLanes): GenerationPlan {
  if (!outL.text && !outL.image) {
    throw new GraphError(
      "Generation block needs at least one outgoing wire (text or image pin)",
    );
  }

  if (outL.image && inL.image) {
    throw new GraphError(
      "Image output needs text-only inputs (disconnect the image pin or switch outputs)",
    );
  }

  if (outL.text && inL.image && !inL.text) {
    throw new GraphError("Image→text isn’t supported — caption from an image instead");
  }

  const needPassthroughText = Boolean(outL.text && inL.text && !inL.image);

  const needCaption = Boolean(outL.text && inL.image);

  const needTextToImage = Boolean(outL.image && inL.text && !inL.image);

  return {
    needPassthroughText,
    needCaption,
    needTextToImage,
  };
}
