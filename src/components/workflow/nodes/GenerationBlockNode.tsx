"use client";

import {
  Handle,
  Position,
  useEdges,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useNodeRunOutput,
  useWorkflowRunContext,
} from "@/components/workflow/WorkflowRunContext";
import {
  FAL_FLUX_IMAGE_SIZE_DIMENSIONS,
  FAL_FLUX_IMAGE_SIZE_LABELS,
  type FalFluxPresetSize,
} from "@/lib/fal/text-to-image-config";
import type { AppNode } from "@/lib/workflow/app-node";
import { NodeLockButton } from "@/components/workflow/nodes/NodeLockButton";

const ASPECT_UI_ORDER = [
  "landscape_16_9",
  "portrait_16_9",
  "square_hd",
  "square",
  "landscape_4_3",
  "portrait_4_3",
] as const satisfies readonly FalFluxPresetSize[];

function isFluxPresetSize(v: string): v is FalFluxPresetSize {
  return ASPECT_UI_ORDER.some((preset) => preset === v);
}

const STEPS_TOOLTIP =
  "Inference steps apply only to Flux Schnell (`FAL_TEXT_TO_IMAGE_MODEL=fal-ai/flux/schnell`). Ignored for GPT Image 2, GPT Image Mini, etc.";

const SUMMARY_CLS =
  "nodrag nopan cursor-pointer select-none list-none px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground [&::-webkit-details-marker]:hidden";

/** Controlled details — resets expansion when wiring changes (`shouldExpand`). */
function CollapsibleSection({
  shouldExpand,
  className,
  summaryClassName,
  summary,
  children,
}: {
  shouldExpand: boolean;
  className?: string;
  summaryClassName: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(shouldExpand);
  useEffect(() => {
    setOpen(shouldExpand);
  }, [shouldExpand]);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={className}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}

/** Derive which output pins have edges — legacy graphs used null handles on image outputs. */
function useOutgoingHandleKinds(nodeId: string) {
  const edges = useEdges();
  return useMemo(() => {
    const kinds = new Set<string>();
    for (const e of edges) {
      if (e.source !== nodeId) continue;
      const sh = e.sourceHandle;
      kinds.add(sh === null || sh === undefined ? "image" : sh);
    }
    const none = kinds.size === 0;
    return {
      kinds,
      none,
      hasTextOut: kinds.has("text"),
      hasImageOut: kinds.has("image"),
    };
  }, [edges, nodeId]);
}

export function GenerationBlockNode(props: NodeProps<AppNode>) {
  const { data, id } = props;
  const { updateNodeData } = useReactFlow();
  const edgesOut = useOutgoingHandleKinds(id);
  const runOut = useNodeRunOutput(id);
  const { activeNodeId, phase } = useWorkflowRunContext();
  const runningHere = phase === "running" && activeNodeId === id;

  if (data.kind !== "generationBlock") return null;

  const openImageSection = edgesOut.hasImageOut || edgesOut.none;

  const genReady =
    runOut?.type === "generation" &&
    (!!runOut.imageUrl?.trim() || !!runOut.text?.trim());

  return (
    <div
      className={`relative min-w-[260px] max-w-[340px] rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm${
        runningHere ? " ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <NodeLockButton
        locked={data.locked}
        disabled={!genReady}
        disabledTitle="Run once to produce output before locking"
        lockedTitle="Locked — reuse prior generation on the next Run when satisfied"
        unlockedTitle="Unlocked — will regenerate on Run"
        variant="inset"
        onToggle={(locked) => updateNodeData(id, { ...data, locked })}
      />
      <div className="relative mb-2 flex gap-3">
        <div className="flex shrink-0 flex-col justify-between gap-8 py-1">
          <Handle
            type="target"
            position={Position.Left}
            id="text"
            style={{ top: 14 }}
            title="Text in"
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
          />
          <Handle
            type="target"
            position={Position.Left}
            id="image"
            style={{ bottom: 14, top: "auto" }}
            title="Image in"
            className="!left-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-start justify-between gap-2 pr-8">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Image
              </span>
              <p
                className="mt-0.5 text-[9px] leading-snug text-muted-foreground"
                title="Green pins: text in · blue pins: reference stills. Outputs story still + optional caption."
              >
                Story still — text & refs in
              </p>
            </div>
          </div>
          {!edgesOut.none && edgesOut.hasTextOut && !edgesOut.hasImageOut ? (
            <p className="mb-2 rounded-md bg-muted/80 px-2 py-1 text-[9px] leading-snug text-muted-foreground">
              Text-only output connected — expand Image below after wiring the image pin if you need visuals.
            </p>
          ) : null}
          <label className="block text-[10px] font-medium text-muted-foreground">Prompt</label>
          <textarea
            className="nodrag nopan nowheel mt-1 h-14 w-full resize-none rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground outline-none"
            placeholder="Style, scene, suffix…"
            value={data.suffix}
            onChange={(e) => updateNodeData(id, { ...data, suffix: e.target.value })}
          />
          <CollapsibleSection
            shouldExpand={openImageSection}
            className="mt-2 rounded-md border border-border bg-muted/20 open:bg-muted/35"
            summaryClassName={SUMMARY_CLS}
            summary="Image · aspect & steps"
          >
            <div className="border-t border-border px-2 pb-2 pt-1">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                  Aspect ratio
                  <select
                    className="min-w-0 max-w-full rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
                    title={`${FAL_FLUX_IMAGE_SIZE_DIMENSIONS[data.imageSize]} — Stories/Reels/TikTok: 9:16 portrait; IG/FB feed squares: 1:1 HD; YouTube: 16:9 landscape; FB horizontal feed: 4:3. Saving from the agent reconciles this from wired exports when labels mention Stories vs Feed.`}
                    value={data.imageSize}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isFluxPresetSize(v)) {
                        updateNodeData(id, { ...data, imageSize: v });
                      }
                    }}
                  >
                    {ASPECT_UI_ORDER.map((preset) => (
                      <option key={preset} value={preset}>
                        {FAL_FLUX_IMAGE_SIZE_LABELS[preset]}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className="flex flex-col gap-1 text-[10px] text-muted-foreground"
                  title={STEPS_TOOLTIP}
                >
                  Steps
                  <input
                    type="number"
                    min={1}
                    max={12}
                    className="rounded-md border border-border bg-card px-1 py-1 text-xs text-card-foreground"
                    title={STEPS_TOOLTIP}
                    value={data.numInferenceSteps}
                    onChange={(e) =>
                      updateNodeData(id, {
                        ...data,
                        numInferenceSteps: Number(e.target.value) || 2,
                      })
                    }
                  />
                </label>
              </div>
            </div>
          </CollapsibleSection>
        </div>

        <div className="flex shrink-0 flex-col justify-between gap-8 py-1">
          <Handle
            type="source"
            position={Position.Right}
            id="text"
            style={{ top: 14 }}
            title="Text out"
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-emerald-500"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="image"
            style={{ bottom: 14, top: "auto" }}
            title="Image out"
            className="!right-[-6px] !h-3 !w-3 !border-2 !border-card !bg-sky-500"
          />
        </div>
      </div>

      {runOut?.type === "generation" ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <p className="text-[9px] font-medium text-muted-foreground">Last run</p>
          {runOut.text ? (
            <p className="max-h-20 overflow-y-auto text-[10px] leading-snug text-foreground">
              {runOut.text}
            </p>
          ) : null}
          {runOut.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={runOut.imageUrl}
              alt=""
              className="max-h-36 w-full rounded-md border border-border object-contain"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
