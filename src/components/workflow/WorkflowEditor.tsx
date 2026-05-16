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
import JSZip from "jszip";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { FlowContextMenuPortal } from "@/components/workflow/FlowContextMenu";
import { FalFluxSchnellNode } from "@/components/workflow/nodes/FalFluxSchnellNode";
import { ImageInputNode } from "@/components/workflow/nodes/ImageInputNode";
import { PlatformExportNode } from "@/components/workflow/nodes/PlatformExportNode";
import { TextInputNode } from "@/components/workflow/nodes/TextInputNode";
import { VideoInputNode } from "@/components/workflow/nodes/VideoInputNode";
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
import {
  deleteWorkflowDoc,
  listWorkflowDocs,
  loadWorkflowDoc,
  saveWorkflowDoc,
} from "@/lib/workflow/storage";

const nodeTypes = {
  textInput: TextInputNode,
  imageInput: ImageInputNode,
  videoInput: VideoInputNode,
  falFluxSchnell: FalFluxSchnellNode,
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
  const [status, setStatus] = useState<string | null>(null);
  const [lastOutputs, setLastOutputs] = useState<RuntimeOutputs | null>(null);
  const [suggestBrief, setSuggestBrief] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const paneFlowAnchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<FlowContextMenuState>({
    kind: "closed",
  });

  const { screenToFlowPosition, viewportInitialized } = useReactFlow<
    AppNode,
    Edge
  >();

  const closeContextMenu = useCallback(() => {
    setContextMenu({ kind: "closed" });
  }, []);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await listWorkflowDocs());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listWorkflowDocs().then((docs) => {
      if (!cancelled) setLibrary(docs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void saveNow();
    }, 1400);
    return () => window.clearTimeout(handle);
  }, [saveNow]);

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

  const addBlock = (type: CanvasNodeType) => {
    const id = crypto.randomUUID();
    const data = defaultNodeData(type);
    setNodes((nds) => [
      ...nds,
      {
        id,
        type,
        position: { x: 40 + nds.length * 28, y: 40 + nds.length * 24 },
        data,
      },
    ]);
  };

  const starterWorkflow = () => {
    const textId = crypto.randomUUID();
    const fluxId = crypto.randomUUID();
    setWorkflowName("Starter · Flux Schnell");
    setWorkflowId(crypto.randomUUID());
    setNodes([
      {
        id: textId,
        type: "textInput",
        position: { x: 0, y: 0 },
        data: {
          kind: "textInput",
          label: "Text",
          value:
            "Minimaliste beverage pour with condensation, studio lighting",
        },
      },
      {
        id: fluxId,
        type: "falFluxSchnell",
        position: { x: 320, y: 0 },
        data: defaultNodeData("falFluxSchnell"),
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
    setStatus("Inserted starter nodes");
  };

  const createBlankWorkflow = () => {
    setWorkflowName("Untitled campaign");
    setWorkflowId(crypto.randomUUID());
    setNodes([]);
    setEdges([]);
    setLastOutputs(null);
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
      const parsed = workflowDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        setStatus("Import failed — file is not a valid workflow");
        return;
      }
      const doc = parsed.data;
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
      setStatus("Imported workflow");
      await saveWorkflowDoc(doc);
      await refreshLibrary();
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
    setStatus(`Loaded “${doc.name}”`);
  };

  const suggestFromServer = async () => {
    const brief = suggestBrief.trim();
    if (!brief) {
      setStatus("Type a brief in the box below first.");
      return;
    }
    setStatus("Generating layout…");
    try {
      const res = await fetch("/api/workflow/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const body: { error?: string; workflow?: unknown } = await res.json();
      if (!res.ok) {
        setStatus(body.error ?? "Suggest failed");
        return;
      }
      const parsed = workflowDocumentSchema.safeParse(body.workflow);
      if (!parsed.success) {
        setStatus("Suggest returned an invalid workflow");
        return;
      }
      const doc = parsed.data;
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
      await saveWorkflowDoc(doc);
      await refreshLibrary();
      setStatus("Applied suggested workflow — review & run.");
    } catch {
      setStatus("Suggest request failed");
    }
  };

  const removeFromLibrary = async (id: string) => {
    await deleteWorkflowDoc(id);
    if (id === workflowId) {
      createBlankWorkflow();
    }
    await refreshLibrary();
  };

  const runGraph = async () => {
    setStatus("Running…");
    setLastOutputs(null);
    try {
      const outputs = await runWorkflowDAG(
        rfNodesToWorkflow(nodes),
        rfEdgesToWorkflow(edges),
        {
          onProgress: (p) => setStatus(p.message ?? p.phase),
        },
      );
      setLastOutputs(outputs);
      setStatus("Run finished");
    } catch (error) {
      setStatus(wrapError(error).message);
    }
  };

  const downloadZip = async () => {
    if (!lastOutputs) {
      setStatus("Run the workflow before downloading a ZIP.");
      return;
    }
    const zip = new JSZip();
    for (const out of Object.values(lastOutputs)) {
      if (out.type === "bundle") {
        for (const file of out.files) {
          zip.file(file.path, file.blob);
        }
      }
    }
    if (Object.keys(zip.files).length === 0) {
      setStatus("Nothing to ZIP — add a Platform export node.");
      return;
    }
    zip.file(
      "manifest.json",
      new Blob(
        [
          JSON.stringify(
            {
              workflowId,
              workflowName,
              generatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const slug = workflowName.replace(/\s+/g, "-").toLowerCase();
    saveAs(blob, `${slug}-export.zip`);
    setStatus("ZIP downloaded");
  };

  return (
    <>
    <div className="flex h-[100dvh] flex-col bg-zinc-50 text-black dark:bg-black dark:text-zinc-50">
      <header className="flex flex-wrap items-center gap-2 border-b border-black/10 px-4 py-3 text-sm dark:border-white/10">
        <div className="mr-auto flex min-w-[200px] flex-1 flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Campaign / workflow title
          </label>
          <input
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            className="rounded-md border border-black/10 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-zinc-950"
          />
        </div>
        <div className="flex flex-1 flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Library
            </span>
            <select
              className="rounded-md border border-black/10 bg-white px-2 py-1 text-xs dark:border-white/15 dark:bg-zinc-950"
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
          </div>
          <button
            type="button"
            className="rounded-md border border-black/10 bg-white px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            onClick={() => void removeFromLibrary(workflowId)}
          >
            Delete current
          </button>
          <button
            type="button"
            className="rounded-md border border-black/10 bg-white px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            onClick={createBlankWorkflow}
          >
            New
          </button>
          <button
            type="button"
            className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
            onClick={() => void runGraph()}
          >
            Run workflow
          </button>
          <button
            type="button"
            className="rounded-md border border-black/10 bg-white px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-white/15 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            onClick={() => void downloadZip()}
          >
            Download ZIP
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 space-y-2 border-r border-black/10 bg-white px-3 py-3 text-xs dark:border-white/10 dark:bg-zinc-950">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Input nodes
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
              onClick={() => addBlock("textInput")}
            >
              Text
            </button>
            <button
              type="button"
              className="rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
              onClick={() => addBlock("imageInput")}
            >
              Image
            </button>
            <button
              type="button"
              className="rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
              onClick={() => addBlock("videoInput")}
            >
              Video
            </button>
          </div>
          <p className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Generation
          </p>
          <button
            type="button"
            className="w-full rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
            onClick={() => addBlock("falFluxSchnell")}
          >
            Flux Schnell (Fal)
          </button>
          <p className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Delivery
          </p>
          <button
            type="button"
            className="w-full rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
            onClick={() => addBlock("platformExport")}
          >
            Platform export
          </button>
          <p className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Quick start
          </p>
          <button
            type="button"
            className="w-full rounded-md border border-dashed border-black/20 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/20 dark:hover:bg-zinc-900"
            onClick={starterWorkflow}
          >
            Insert Text → Flux graph
          </button>
          <p className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Suggest layout (template)
          </p>
          <textarea
            value={suggestBrief}
            onChange={(e) => setSuggestBrief(e.target.value)}
            placeholder="e.g. Summer soda promo for Gen Z, mention TikTok…"
            className="min-h-[72px] w-full resize-none rounded-md border border-black/10 bg-zinc-50 px-2 py-1 text-[11px] text-black outline-none dark:border-white/15 dark:bg-black dark:text-zinc-50"
          />
          <button
            type="button"
            className="w-full rounded-md border border-black/10 bg-black px-2 py-1 text-left text-[11px] font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
            onClick={() => void suggestFromServer()}
          >
            Apply suggestion
          </button>
          <div className="pt-4 space-y-2 border-t border-black/10 dark:border-white/10">
            <button
              type="button"
              className="w-full rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
              onClick={exportJson}
            >
              Export JSON
            </button>
            <button
              type="button"
              className="w-full rounded-md border border-black/10 px-2 py-1 text-left hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-zinc-900"
              onClick={() => importRef.current?.click()}
            >
              Import JSON
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importJsonFile(file);
              }}
            />
          </div>
        </aside>

        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={onPaneClick}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} variant={BackgroundVariant.Dots} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-black/10 bg-white px-4 py-2 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300">
        {status ? <span>{status}</span> : <span>Idle</span>}
        {lastOutputs ? (
          <span className="text-zinc-500">
            Last run: {Object.keys(lastOutputs).length} node outputs
          </span>
        ) : null}
      </footer>
    </div>
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
    />
    </>
  );
}
