"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { WorkflowEditor } from "./WorkflowEditor";

export function WorkflowShell() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  );
}
