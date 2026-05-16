"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import { saveAs } from "file-saver";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { FlowContextMenuPortal } from "@/components/workflow/FlowContextMenu";
import { WorkflowAgentPanel } from "@/components/workflow/WorkflowAgentPanel";
import {
  WorkflowRunProvider,
  type WorkflowRunPhase,
} from "@/components/workflow/WorkflowRunContext";
import { GenerationBlockNode } from "@/components/workflow/nodes/GenerationBlockNode";
import { MediaInputNode } from "@/components/workflow/nodes/MediaInputNode";
import { PlatformExportNode } from "@/components/workflow/nodes/PlatformExportNode";
import type { AppNode } from "@/lib/workflow/app-node";
import { topLeftForCenteredNode } from "@/lib/workflow/node-layout";
import {
  WORKFLOW_DOCUMENT_VERSION,
  defaultNodeData,
  workflowDocumentSchema,
  type CanvasNodeType,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "@/lib/workflow/schema";
import { runWorkflowDAG, wrapError, type RuntimeOutputs } from "@/lib/workflow/runner";
import { logWorkflow } from "@/lib/workflow/workflow-debug-log";
import { areWorkflowHandlesCompatible } from "@/lib/workflow/workflow-connection";
import {
  clearLastLoadedWorkflowId,
  deleteWorkflowDoc,
  getLastLoadedWorkflowId,
  getLatestRunArtifactRecordsForWorkflow,
  listWorkflowDocs,
  loadWorkflowDoc,
  persistWorkflowRunArtifacts,
  rehydrateRuntimeOutputsFromArtifacts,
  saveWorkflowDoc,
  setLastLoadedWorkflowId,
} from "@/lib/workflow/storage";
import { normalizeWorkflowDocument } from "@/lib/workflow/migrate";
import { estimateWorkflowFalUsd } from "@/lib/workflow/estimate-workflow-fal-usd";

const nodeTypes = {
  mediaInput: MediaInputNode,
  generationBlock: GenerationBlockNode,
  platformExport: PlatformExportNode,
} satisfies NodeTypes;

function rfNodesToWorkflow(nodes: AppNode[]): WorkflowNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: String(n.type),
    position: n.position,
    data: n.data,
  }));
}

function rfEdgesToWorkflow(edges: Edge[]): WorkflowEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));
}

type FlowContextMenuState =
  | { kind: "closed" }
  | {
      kind: "pane";
      clientX: number;
      clientY: number;
    }
  | { kind: "node"; clientX: number; clientY: number; nodeId: string };

export function WorkflowEditor() {
  const [workflowName, setWorkflowName] = useState("Untitled campaign");
  const [workflowId, setWorkflowId] = useState(() => crypto.randomUUID());
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [library, setLibrary] = useState<WorkflowDocument[]>([]);
  /** False until IndexedDB has been read and optional latest workflow applied — avoids autosaving an empty doc before hydrate. */
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastOutputs, setLastOutputs] = useState<RuntimeOutputs | null>(null);
  const [liveOutputs, setLiveOutputs] = useState<RuntimeOutputs | null>(null);
  const [runPhase, setRunPhase] = useState<WorkflowRunPhase>("idle");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const importRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  /** Avoid re-fetching IndexedDB for the same workflow when `lastOutputs` is empty. */
  const restoredMediaForWorkflowRef = useRef<string | null>(null);
  /** Mirrors completed node outputs during the current run (state updates can lag behind `catch`). */
  const partialRunOutputsRef = useRef<RuntimeOutputs>({});
  /** Outputs present when Run was clicked; restored if the new run errors before any node completes. */
  const outputsSnapshotBeforeRunRef = useRef<RuntimeOutputs | null>(null);
  const paneFlowAnchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<FlowContextMenuState>({
    kind: "closed",
  });
  const [themeMounted, setThemeMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    queueMicrotask(() => setThemeMounted(true));
  }, []);

  const flowColorMode =
    themeMounted && resolvedTheme === "dark" ? "dark" : "light";

  const { screenToFlowPosition, viewportInitialized, getNode } = useReactFlow<
    AppNode,
    Edge
  >();

  const runContextValue = useMemo(
    () => ({
      outputs: lastOutputs,
      liveOutputs,
      activeNodeId,
      phase: runPhase,
    }),
    [lastOutputs, liveOutputs, activeNodeId, runPhase],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu({ kind: "closed" });
  }, []);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await listWorkflowDocs());
  }, []);

  const applyWorkflowDocument = useCallback(
    async (doc: WorkflowDocument) => {
      restoredMediaForWorkflowRef.current = null;
      setLastLoadedWorkflowId(doc.id);
      setWorkflowId(doc.id);
      setWorkflowName(doc.name);
      setNodes(
        doc.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          data: n.data,
        })),
      );
      setEdges(
        doc.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? undefined,
          targetHandle: e.targetHandle ?? undefined,
          animated: true,
        })),
      );
      setLastOutputs(null);
      setLiveOutputs(null);
      setRunPhase("idle");
      setActiveNodeId(null);
      await saveWorkflowDoc(doc);
      await refreshLibrary();
    },
    [refreshLibrary, setEdges, setNodes],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const docs = await listWorkflowDocs();
      if (cancelled) return;
      setLibrary(docs);

      const preferredId = getLastLoadedWorkflowId();
      let doc: WorkflowDocument | undefined;
      if (preferredId) {
        doc = await loadWorkflowDoc(preferredId);
        if (!doc) {
          clearLastLoadedWorkflowId();
        }
      }
      // No remembered workflow yet (first visit): keep previous behavior — open newest by updatedAt.
      if (!doc && docs.length > 0 && !preferredId) {
        doc = await loadWorkflowDoc(docs[0]!.id);
      }

      if (doc && !cancelled) {
        setLastLoadedWorkflowId(doc.id);
        setWorkflowId(doc.id);
        setWorkflowName(doc.name);
        setNodes(
          doc.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data,
          })),
        );
        setEdges(
          doc.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
            targetHandle: e.targetHandle ?? undefined,
            animated: true,
          })),
        );
        setLastOutputs(null);
        setLiveOutputs(null);
        setRunPhase("idle");
        setActiveNodeId(null);
      }
      setStorageHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [setEdges, setNodes]);

  const saveNow = useCallback(async () => {
    const doc = {
      id: workflowId,
      name: workflowName,
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes: rfNodesToWorkflow(nodes),
      edges: rfEdgesToWorkflow(edges),
      updatedAt: new Date().toISOString(),
    };
    const parsed = workflowDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      setStatus("Cannot autosave — workflow failed validation.");
      return;
    }
    await saveWorkflowDoc(parsed.data);
    await refreshLibrary();
  }, [workflowId, workflowName, nodes, edges, refreshLibrary]);

  const getAgentCanvasSnapshot = useCallback((): WorkflowDocument | null => {
    const doc = {
      id: workflowId,
      name: workflowName.trim() || "Untitled campaign",
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes: rfNodesToWorkflow(nodes),
      edges: rfEdgesToWorkflow(edges),
      updatedAt: new Date().toISOString(),
    };
    const parsed = workflowDocumentSchema.safeParse(doc);
    return parsed.success ? parsed.data : null;
  }, [workflowId, workflowName, nodes, edges]);

  const falRunCostEstimate = useMemo(() => {
    const snap = getAgentCanvasSnapshot();
    if (!snap) return null;
    return estimateWorkflowFalUsd(snap);
  }, [getAgentCanvasSnapshot]);

  const falEstimateTooltip = useMemo(() => {
    if (!falRunCostEstimate) {
      return "Validating the workflow…";
    }
    if (!falRunCostEstimate.ok) {
      return falRunCostEstimate.error;
    }
    const { totalUsd, lineItems, disclaimer } = falRunCostEstimate;
    const lines = lineItems.map(
      (li) =>
        `${li.label}: ${li.calls.map((c) => `${c.intent} $${c.usd.toFixed(2)}`).join(", ")}`,
    );
    return `Est. fal.ai cost (one successful run): ~$${totalUsd.toFixed(2)}\n\n${lines.join("\n")}\n\n${disclaimer}`;
  }, [falRunCostEstimate]);

  useEffect(() => {
    if (!storageHydrated) return;
    const handle = window.setTimeout(() => {
      void saveNow();
    }, 1400);
    return () => window.clearTimeout(handle);
  }, [storageHydrated, saveNow]);

  useEffect(() => {
    if (!storageHydrated) return;
    if (lastOutputs) return;
    if (runPhase === "running") return;
    if (nodes.length === 0) return;
    if (restoredMediaForWorkflowRef.current === workflowId) return;

    let cancelled = false;
    void (async () => {
      const records = await getLatestRunArtifactRecordsForWorkflow(workflowId);
      if (cancelled) return;
      if (!records?.length) {
        restoredMediaForWorkflowRef.current = workflowId;
        return;
      }
      const restored = await rehydrateRuntimeOutputsFromArtifacts(
        records,
        rfNodesToWorkflow(nodes),
      );
      if (cancelled) return;
      if (!restored || Object.keys(restored).length === 0) {
        restoredMediaForWorkflowRef.current = workflowId;
        return;
      }
      restoredMediaForWorkflowRef.current = workflowId;
      setLastOutputs(restored);
      setLiveOutputs(restored);
      setRunPhase("done");
      setStatus(
        "Restored last run media from IndexedDB (images/video blobs). localStorage keeps a small text snapshot only.",
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [storageHydrated, workflowId, lastOutputs, runPhase, nodes]);

  useEffect(() => {
    if (contextMenu.kind === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    const onPointer = (e: PointerEvent) => {
      if (contextMenuRef.current?.contains(e.target as globalThis.Node)) return;
      closeContextMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [contextMenu.kind, closeContextMenu]);

  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent<Element> | MouseEvent) => {
      e.preventDefault();
      if (!viewportInitialized) return;
      const flow = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      paneFlowAnchorRef.current = { x: flow.x, y: flow.y };
      setContextMenu({
        kind: "pane",
        clientX: e.clientX,
        clientY: e.clientY,
      });
    },
    [screenToFlowPosition, viewportInitialized],
  );

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: AppNode) => {
      e.preventDefault();
      setContextMenu({
        kind: "node",
        clientX: e.clientX,
        clientY: e.clientY,
        nodeId: node.id,
      });
    },
    [],
  );

  const onPaneClick = useCallback(() => {
    closeContextMenu();
  }, [closeContextMenu]);

  const addBlockAtCursor = useCallback(
    (type: CanvasNodeType) => {
      const { x: cx, y: cy } = paneFlowAnchorRef.current;
      const id = crypto.randomUUID();
      const data = defaultNodeData(type);
      const position = topLeftForCenteredNode({ x: cx, y: cy }, type);
      setNodes((nds) => [...nds, { id, type, position, data }]);
      setStatus(`Added ${type}`);
      closeContextMenu();
    },
    [closeContextMenu, setNodes],
  );

  const duplicateContextNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) {
        closeContextMenu();
        return;
      }
      const newId = crypto.randomUUID();
      setNodes((nds) => [
        ...nds,
        {
          id: newId,
          type: node.type,
          position: {
            x: node.position.x + 48,
            y: node.position.y + 48,
          },
          data: structuredClone(node.data),
        },
      ]);
      setStatus("Duplicated node");
      closeContextMenu();
    },
    [closeContextMenu, nodes, setNodes],
  );

  const deleteContextNode = useCallback(
    (nodeId: string) => {
      setEdges((eds) =>
        eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setStatus("Deleted node");
      closeContextMenu();
    },
    [closeContextMenu, setEdges, setNodes],
  );

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            animated: true,
          },
          eds,
        ),
      ),
    [setEdges],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const source = getNode(c.source);
      const target = getNode(c.target);
      if (!source || !target) return false;
      if (c.source === c.target) return false;
      return areWorkflowHandlesCompatible(
        String(source.type),
        c.sourceHandle ?? null,
        String(target.type),
        c.targetHandle ?? null,
      );
    },
    [getNode],
  );

  const starterWorkflow = () => {
    const textId = crypto.randomUUID();
    const fluxId = crypto.randomUUID();
    const nextId = crypto.randomUUID();
    setWorkflowName("Starter · Text → image");
    setWorkflowId(nextId);
    setLastLoadedWorkflowId(nextId);
    setNodes([
      {
        id: textId,
        type: "mediaInput",
        position: { x: 0, y: 0 },
        data: {
          kind: "mediaInput",
          label: "Campaign input",
          value:
            "Minimaliste beverage pour with condensation, studio lighting",
          images: [],
          videos: [],
        },
      },
      {
        id: fluxId,
        type: "generationBlock",
        position: { x: 320, y: 0 },
        data: defaultNodeData("generationBlock"),
      },
    ]);
    setEdges([
      {
        id: `e-${textId}-${fluxId}`,
        source: textId,
        target: fluxId,
        sourceHandle: "text",
        targetHandle: "text",
        animated: true,
      },
    ]);
    setLastOutputs(null);
    setLiveOutputs(null);
    setRunPhase("idle");
    setActiveNodeId(null);
    setStatus("Inserted starter nodes");
  };

  const createBlankWorkflow = () => {
    restoredMediaForWorkflowRef.current = null;
    const nextId = crypto.randomUUID();
    setWorkflowName("Untitled campaign");
    setWorkflowId(nextId);
    setLastLoadedWorkflowId(nextId);
    setNodes([]);
    setEdges([]);
    setLastOutputs(null);
    setLiveOutputs(null);
    setRunPhase("idle");
    setActiveNodeId(null);
    setStatus("New workflow");
  };

  const exportJson = () => {
    const doc = {
      id: workflowId,
      name: workflowName,
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes: rfNodesToWorkflow(nodes),
      edges: rfEdgesToWorkflow(edges),
      updatedAt: new Date().toISOString(),
    };
    const parsed = workflowDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      setStatus("Export blocked — invalid workflow");
      return;
    }
    const blob = new Blob([JSON.stringify(parsed.data, null, 2)], {
      type: "application/json",
    });
    const slug = workflowName.replace(/\s+/g, "-").toLowerCase();
    saveAs(blob, `${slug}.workflow.json`);
  };

  const importJsonFile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const doc = normalizeWorkflowDocument(raw);
      if (!doc) {
        setStatus("Import failed — file is not a valid workflow");
        return;
      }
      await applyWorkflowDocument(doc);
      setStatus("Imported workflow");
    } catch {
      setStatus("Import failed — invalid JSON");
    }
  };

  const loadFromLibrary = async (id: string) => {
    if (!id) return;
    const doc = await loadWorkflowDoc(id);
    if (!doc) {
      setStatus("Workflow missing from storage");
      return;
    }
    await applyWorkflowDocument(doc);
    setStatus(`Loaded “${doc.name}”`);
  };

  const removeFromLibrary = async (id: string) => {
    await deleteWorkflowDoc(id);
    if (id === workflowId) {
      createBlankWorkflow();
    }
    await refreshLibrary();
  };

  const runGraph = async () => {
    const workflowNodes = rfNodesToWorkflow(nodes);

    logWorkflow("info", "WorkflowEditor", "Run workflow", {
      workflowId,
      workflowName,
    });

    setStatus("Running…");
    outputsSnapshotBeforeRunRef.current = lastOutputs ? { ...lastOutputs } : null;
    partialRunOutputsRef.current = {};
    setLastOutputs(null);
    setLiveOutputs({});
    setRunPhase("running");
    setActiveNodeId(null);
    try {
      const outputs = await runWorkflowDAG(
        workflowNodes,
        rfEdgesToWorkflow(edges),
        {
          onProgress: (p) => setStatus(p.message ?? p.phase),
          onNodeComplete: (e) => {
            partialRunOutputsRef.current = {
              ...partialRunOutputsRef.current,
              [e.nodeId]: e.output,
            };
            setLiveOutputs((prev) => ({
              ...(prev ?? {}),
              [e.nodeId]: e.output,
            }));
            setActiveNodeId(e.nodeId);
          },
        },
      );
      setLastOutputs(outputs);
      setLiveOutputs(outputs);
      setActiveNodeId(null);
      setRunPhase("done");
      setStatus("Run finished");
      logWorkflow("info", "WorkflowEditor", "Run finished OK", {
        outputNodes: Object.keys(outputs).length,
      });
      void persistWorkflowRunArtifacts(
        workflowId,
        workflowName,
        workflowNodes,
        outputs,
      ).then(({ count }) => {
        if (count > 0) {
          setStatus(
            `Run finished — saved ${count} file(s) (media in IndexedDB; text snippets mirrored to localStorage).`,
          );
        }
      });
    } catch (error) {
      const ge = wrapError(error);
      logWorkflow("error", "WorkflowEditor", "Run failed", {
        message: ge.message,
      });
      setRunPhase("error");
      const partial = partialRunOutputsRef.current;
      const snap = outputsSnapshotBeforeRunRef.current;
      const restored =
        Object.keys(partial).length > 0
          ? { ...partial }
          : snap && Object.keys(snap).length > 0
            ? { ...snap }
            : null;
      setLastOutputs(restored);
      setLiveOutputs(restored);
      if (!restored) {
        restoredMediaForWorkflowRef.current = null;
      }
      setActiveNodeId(null);
      setStatus(ge.message);
    }
  };

  return (
    <>
    <WorkflowRunProvider value={runContextValue}>
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:min-w-[12rem]">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Editor
            </label>
            <input
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-card-foreground"
            />
          </div>
          <div className="flex max-w-full shrink-0 flex-wrap items-end justify-end gap-2 lg:flex-nowrap">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Library
              </span>
              <div className="flex items-center gap-1">
                <select
                  className="min-w-[8.5rem] max-w-[14rem] rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground sm:min-w-[10rem]"
                  defaultValue=""
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    void loadFromLibrary(v);
                  }}
                >
                  <option value="" disabled>
                    Load saved…
                  </option>
                  {library.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  title="New campaign"
                  className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-sm font-semibold leading-none text-card-foreground hover:bg-accent"
                  onClick={createBlankWorkflow}
                >
                  +
                </button>
              </div>
            </div>
            <button
              type="button"
              title="Delete current workflow"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground hover:bg-accent"
              onClick={() => void removeFromLibrary(workflowId)}
            >
              <span className="sr-only">Delete current workflow</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" x2="10" y1="11" y2="17" />
                <line x1="14" x2="14" y1="11" y2="17" />
              </svg>
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => void runGraph()}
            >
              Run workflow
            </button>
            <Link
              href="/settings/connections"
              className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent"
            >
              Social accounts
            </Link>
            <ThemeToggle />
            <div className="flex min-w-[4.5rem] shrink-0 flex-col items-end justify-end pb-0.5 text-right">
              {falRunCostEstimate?.ok ? (
                <span
                  className="text-[10px] font-medium text-muted-foreground"
                  title={falEstimateTooltip}
                >
                  Est. fal ~${falRunCostEstimate.totalUsd.toFixed(2)}
                </span>
              ) : falRunCostEstimate && !falRunCostEstimate.ok ? (
                <span
                  className="max-w-[7rem] text-[10px] leading-tight text-amber-600 dark:text-amber-500"
                  title={falEstimateTooltip}
                >
                  Cost est. unavailable
                </span>
              ) : (
                <span
                  className="text-[10px] text-muted-foreground"
                  title={falEstimateTooltip}
                >
                  Est. fal · …
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <WorkflowAgentPanel
          getCanvasSnapshot={getAgentCanvasSnapshot}
          onApplyDocument={(doc) => applyWorkflowDocument(doc)}
          onStatus={setStatus}
        />

        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onPaneClick={onPaneClick}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            nodeTypes={nodeTypes}
            colorMode={flowColorMode}
            minZoom={0.06}
            maxZoom={8}
            fitView
            fitViewOptions={{ minZoom: 0.06, maxZoom: 8, padding: 0.12 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} variant={BackgroundVariant.Dots} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importJsonFile(file);
        }}
      />

      <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="shrink-0 text-foreground">{status ?? "Idle"}</span>
          {falRunCostEstimate?.ok ? (
            <span
              className="min-w-0 max-w-full shrink border-l border-border pl-3 font-medium text-foreground"
              title={falEstimateTooltip}
            >
              Fal estimate · ~${falRunCostEstimate.totalUsd.toFixed(2)} per successful run
            </span>
          ) : falRunCostEstimate && !falRunCostEstimate.ok ? (
            <span
              className="min-w-0 shrink border-l border-border pl-3 text-amber-600 dark:text-amber-500"
              title={falEstimateTooltip}
            >
              Fal estimate unavailable (fix graph wiring)
            </span>
          ) : (
            <span className="border-l border-border pl-3 text-muted-foreground/80">
              Fal estimate · — (invalid workflow document)
            </span>
          )}
        </div>
        {lastOutputs ? (
          <span>
            Last run: {Object.keys(lastOutputs).length} node outputs
          </span>
        ) : null}
        <span className="text-[10px] text-muted-foreground/90">
          Execution order is topological (dependencies first); among ready nodes, the left-most runs first.
        </span>
      </footer>
    </div>
    </WorkflowRunProvider>
    <FlowContextMenuPortal
      menu={
        contextMenu.kind === "closed"
          ? null
          : contextMenu.kind === "pane"
            ? {
                kind: "pane",
                clientX: contextMenu.clientX,
                clientY: contextMenu.clientY,
              }
            : {
                kind: "node",
                clientX: contextMenu.clientX,
                clientY: contextMenu.clientY,
                nodeId: contextMenu.nodeId,
              }
      }
      menuRef={contextMenuRef}
      onAddBlock={addBlockAtCursor}
      onDuplicateNode={duplicateContextNode}
      onDeleteNode={deleteContextNode}
      onStarterWorkflow={() => {
        starterWorkflow();
        closeContextMenu();
      }}
      onExportJson={() => {
        exportJson();
        closeContextMenu();
      }}
      onTriggerImport={() => {
        importRef.current?.click();
        closeContextMenu();
      }}
    />
    </>
  );
}
