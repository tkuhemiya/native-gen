import { GraphError } from "./graph";
import type { WorkflowEdge } from "./schema";

export type MediaLanes = {
  text: boolean;
  image: boolean;
  video: boolean;
};

/** Incoming edges hitting this generation node (by target handle). */
export function incomingMediaLanes(
  nodeId: string,
  incomingByTarget: Map<string, WorkflowEdge[]>,
): MediaLanes {
  const lanes = { text: false, image: false, video: false };
  for (const edge of incomingByTarget.get(nodeId) ?? []) {
    const th = edge.targetHandle ?? null;
    if (th === "image") lanes.image = true;
    else if (th === "video") lanes.video = true;
    else lanes.text = true;
  }
  return lanes;
}

/** Downstream pulls by source handle from this generation node. */
export function outgoingMediaLanes(nodeId: string, edges: WorkflowEdge[]): MediaLanes {
  const lanes = { text: false, image: false, video: false };
  for (const e of edges) {
    if (e.source !== nodeId) continue;
    const sh = e.sourceHandle ?? null;
    if (sh === "text") lanes.text = true;
    else if (sh === "image") lanes.image = true;
    else if (sh === "video") lanes.video = true;
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
  needTextToVideo: boolean;
  needImageToVideo: boolean;
  needVideoToVideo: boolean;
};

/**
 * Decide which fal jobs to run from wired pins. Raises {@link GraphError} when pins disagree.
 */
export function planGeneration(inL: MediaLanes, outL: MediaLanes): GenerationPlan {
  if (!outL.text && !outL.image && !outL.video) {
    throw new GraphError(
      "Generation block needs at least one outgoing wire (text, image, or video pin)",
    );
  }

  if (outL.image && (inL.image || inL.video)) {
    throw new GraphError(
      "Image output needs text-only inputs (disconnect image/video pins or switch outputs)",
    );
  }

  if (outL.video) {
    if (inL.video && inL.image) {
      throw new GraphError(
        "Video generation: wire either video continuation or image (+ optional text), not both",
      );
    }
    if (!inL.text && !inL.image && !inL.video) {
      throw new GraphError("Video output needs text, image, or video wired in");
    }
  }

  if (outL.text && inL.video && !inL.image && !inL.text) {
    throw new GraphError("Video→text isn’t supported — caption from an image instead");
  }

  const needPassthroughText = Boolean(outL.text && inL.text && !inL.image && !inL.video);

  const needCaption = Boolean(outL.text && inL.image && !inL.video);

  const needTextToImage = Boolean(outL.image && inL.text && !inL.image && !inL.video);

  let needTextToVideo = false;
  let needImageToVideo = false;
  let needVideoToVideo = false;

  if (outL.video) {
    if (inL.video) needVideoToVideo = true;
    else if (inL.image) needImageToVideo = true;
    else needTextToVideo = true;
  }

  return {
    needPassthroughText,
    needCaption,
    needTextToImage,
    needTextToVideo,
    needImageToVideo,
    needVideoToVideo,
  };
}
