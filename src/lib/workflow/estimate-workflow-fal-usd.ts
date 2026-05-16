import {
  FAL_FLORENCE_CAPTION_ESTIMATE_USD,
  FAL_PRICING_DISCLAIMER,
  falFluxSchnellImageUsd,
  falVeo31LiteRunUsd,
  falWan27RunUsd,
} from "@/lib/fal/fal-model-pricing";
import { assertConnectedDAG, GraphError } from "./graph";
import {
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
} from "./generation-plan";
import type { WorkflowDocument } from "./schema";
import { buildIncomingByTarget } from "./workflow-plan";

export type FalCostLineCall = {
  intent: string;
  usd: number;
  detail: string;
};

export type FalCostLineItem = {
  nodeId: string;
  label: string;
  calls: FalCostLineCall[];
};

export type EstimateWorkflowFalUsdResult =
  | {
      ok: true;
      lineItems: FalCostLineItem[];
      totalUsd: number;
      disclaimer: string;
    }
  | { ok: false; error: string };

/**
 * Predict fal spend for one successful run over `doc`, using the same `planGeneration`
 * routing as `runWorkflowDAG` and rates from `fal-model-pricing.ts`.
 */
export function estimateWorkflowFalUsd(doc: WorkflowDocument): EstimateWorkflowFalUsdResult {
  try {
    assertConnectedDAG(doc.nodes, doc.edges);
  } catch (e) {
    return { ok: false, error: e instanceof GraphError ? e.message : String(e) };
  }

  const incomingByTarget = buildIncomingByTarget(doc.edges);
  const lineItems: FalCostLineItem[] = [];
  let totalUsd = 0;

  for (const node of doc.nodes) {
    if (node.data.kind !== "generationBlock") continue;

    let plan;
    try {
      const inL = incomingMediaLanes(node.id, incomingByTarget);
      const outL = outgoingMediaLanes(node.id, doc.edges);
      plan = planGeneration(inL, outL);
    } catch (e) {
      return { ok: false, error: e instanceof GraphError ? e.message : String(e) };
    }

    const calls: FalCostLineCall[] = [];
    const label = node.data.label.trim() || "Generation";

    if (plan.needPassthroughText) {
      calls.push({ intent: "text-passthrough", usd: 0, detail: "No fal call (text only)" });
    }
    if (plan.needCaption) {
      calls.push({
        intent: "image-to-text",
        usd: FAL_FLORENCE_CAPTION_ESTIMATE_USD,
        detail: "fal-ai/florence-2-large/caption (listed $0/compute-s on fal)",
      });
    }
    if (plan.needTextToImage) {
      const usd = falFluxSchnellImageUsd(node.data.imageSize);
      calls.push({
        intent: "text-to-image",
        usd,
        detail: `fal-ai/flux/schnell · ${node.data.imageSize} · $0.003/MP`,
      });
    }
    if (plan.needTextToVideo) {
      const usd = falVeo31LiteRunUsd({
        duration: node.data.videoDuration,
        resolution: node.data.videoResolution,
        videoSilent: node.data.videoSilent,
      });
      const audio = node.data.videoSilent ? "silent" : "with audio";
      calls.push({
        intent: "text-to-video",
        usd,
        detail: `fal-ai/veo3.1/lite · ${node.data.videoDuration} · ${node.data.videoResolution} · ${audio}`,
      });
    }
    if (plan.needImageToVideo) {
      const usd = falWan27RunUsd(node.data.wanDurationSec, node.data.wanResolution);
      calls.push({
        intent: "image-to-video",
        usd,
        detail: `fal-ai/wan/v2.7/image-to-video · ${node.data.wanDurationSec}s · ${node.data.wanResolution}`,
      });
    }
    if (plan.needVideoToVideo) {
      const usd = falWan27RunUsd(node.data.wanDurationSec, node.data.wanResolution);
      calls.push({
        intent: "video-to-video",
        usd,
        detail: `fal-ai/wan/v2.7/image-to-video · ${node.data.wanDurationSec}s · ${node.data.wanResolution} (video in)`,
      });
    }

    lineItems.push({ nodeId: node.id, label, calls });
    totalUsd += calls.reduce((a, c) => a + c.usd, 0);
  }

  return {
    ok: true,
    lineItems,
    totalUsd: Math.round(totalUsd * 100) / 100,
    disclaimer: FAL_PRICING_DISCLAIMER,
  };
}
