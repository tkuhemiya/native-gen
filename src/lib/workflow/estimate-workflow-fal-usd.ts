import {
  FAL_FLORENCE_CAPTION_ESTIMATE_USD,
  FAL_OPENAI_GPT_IMAGE_2_EDIT_ESTIMATE_USD,
  FAL_PRICING_DISCLAIMER,
  falImageToVideoUsdForEndpoint,
  falTextToImageUsdForEndpoint,
} from "@/lib/fal/fal-model-pricing";
import {
  getFalImageEditEndpointId,
  getFalTextToImageEndpointId,
} from "@/lib/fal/text-to-image-config";
import { getFalImageToVideoEndpointId } from "@/lib/fal/video-config";
import { assertConnectedDAG, buildIncomingByTarget, GraphError } from "./graph";
import {
  incomingMediaLanes,
  outgoingMediaLanes,
  planGeneration,
} from "./generation-plan";
import type { WorkflowDocument } from "./schema";

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
  const textToImageEndpointId = getFalTextToImageEndpointId();
  const imageToVideoEndpointId = getFalImageToVideoEndpointId();
  const lineItems: FalCostLineItem[] = [];
  let totalUsd = 0;

  for (const node of doc.nodes) {
    if (node.data.kind === "generationBlock") {
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
      if (plan.needTextToImage && plan.needReferenceImageEdit) {
        calls.push({
          intent: "image-to-image-edit",
          usd: FAL_OPENAI_GPT_IMAGE_2_EDIT_ESTIMATE_USD,
          detail: `${getFalImageEditEndpointId()} · low / reduced presets`,
        });
      } else if (plan.needTextToImage) {
        const usd = falTextToImageUsdForEndpoint(textToImageEndpointId, node.data.imageSize);
        calls.push({
          intent: "text-to-image",
          usd,
          detail: `${textToImageEndpointId} · ${node.data.imageSize}`,
        });
      }

      lineItems.push({ nodeId: node.id, label, calls });
      totalUsd += calls.reduce((a, c) => a + c.usd, 0);
      continue;
    }

    if (node.data.kind === "videoBlock") {
      const label = node.data.label.trim() || "Animate";
      const usd = falImageToVideoUsdForEndpoint(
        imageToVideoEndpointId,
        node.data.durationSec,
        node.data.resolution,
      );
      lineItems.push({
        nodeId: node.id,
        label,
        calls: [
          {
            intent: "image-to-video",
            usd,
            detail: `${imageToVideoEndpointId} · ${node.data.durationSec}s · ${node.data.resolution} · ${node.data.aspectRatio}`,
          },
        ],
      });
      totalUsd += usd;
    }
  }

  return {
    ok: true,
    lineItems,
    totalUsd: Math.round(totalUsd * 100) / 100,
    disclaimer: FAL_PRICING_DISCLAIMER,
  };
}
