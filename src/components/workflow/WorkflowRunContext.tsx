"use client";

import { createContext, useContext } from "react";

import type { RuntimeOutputs } from "@/lib/workflow/runner";

export type WorkflowRunPhase = "idle" | "running" | "done" | "error";

const EMPTY_GENERATING_NODE_IDS = new Set<string>();

export type WorkflowRunContextValue = {
  /** Latest finished run (full map). */
  outputs: RuntimeOutputs | null;
  /** Fills node-by-node while a run is in progress. */
  liveOutputs: RuntimeOutputs | null;
  activeNodeId: string | null;
  /** Fal still / video jobs in flight (supports parallel waves). */
  generatingNodeIds: ReadonlySet<string>;
  phase: WorkflowRunPhase;
};

const WorkflowRunContext = createContext<WorkflowRunContextValue>({
  outputs: null,
  liveOutputs: null,
  activeNodeId: null,
  generatingNodeIds: EMPTY_GENERATING_NODE_IDS,
  phase: "idle",
});

export function WorkflowRunProvider({
  value,
  children,
}: {
  value: WorkflowRunContextValue;
  children: React.ReactNode;
}) {
  return (
    <WorkflowRunContext.Provider value={value}>
      {children}
    </WorkflowRunContext.Provider>
  );
}

export function useWorkflowRunContext() {
  return useContext(WorkflowRunContext);
}

/** Prefer live partial results while running; otherwise last completed outputs. */
export function useNodeRunOutput(nodeId: string) {
  const { liveOutputs, outputs, phase } = useWorkflowRunContext();
  if (phase === "running" && liveOutputs && nodeId in liveOutputs) {
    return liveOutputs[nodeId]!;
  }
  return outputs?.[nodeId] ?? null;
}

/** True while this node is waiting on a fal generation / video render. */
export function useIsNodeGenerating(nodeId: string): boolean {
  const { generatingNodeIds, phase } = useWorkflowRunContext();
  return phase === "running" && generatingNodeIds.has(nodeId);
}
