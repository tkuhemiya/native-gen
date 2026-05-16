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
import { areWorkflowHandlesCompatible } from "@/lib/workflow/workflow-connection";
import {
  clearLastLoadedWorkflowId,
  deleteWorkflowDoc,
  getLastLoadedWorkflowId,
  listWorkflowDocs,
  loadWorkflowDoc,
  persistWorkflowRunArtifacts,
  saveWorkflowDoc,
  setLastLoadedWorkflowId,
} from "@/lib/workflow/storage";
import { zipRuntimeOutputs } from "@/lib/workflow/zip-outputs";
import { normalizeWorkflowDocument } from "@/lib/workflow/migrate";

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

  const metaPublishCandidates = useMemo(() => {
    if (!lastOutputs) return [] as AppNode[];
    return nodes.filter((n) => {
      if (n.data.kind !== "platformExport") return false;
      if (n.data.platform !== "facebook" && n.data.platform !== "instagram") return false;
      if (!n.data.metaPageId?.trim()) return false;
      const o = lastOutputs[n.id];
      return o?.type === "bundle" && o.publish != null;
    });
  }, [nodes, lastOutputs]);

  const canPublishMeta = metaPublishCandidates.length > 0;

  const [metaPublishTargetId, setMetaPublishTargetId] = useState<string | null>(null);
  useEffect(() => {
    if (metaPublishCandidates.length === 0) {
      setMetaPublishTargetId(null);
      return;
    }
    setMetaPublishTargetId((prev) =>
      prev && metaPublishCandidates.some((c) => c.id === prev)
        ? prev
        : metaPublishCandidates[0]!.id,
    );
  }, [metaPublishCandidates]);

  const youtubePublishCandidates = useMemo(() => {
    if (!lastOutputs) return [] as AppNode[];
    return nodes.filter((n) => {
      if (n.data.kind !== "platformExport") return false;
      if (n.data.platform !== "youtube") return false;
      const o = lastOutputs[n.id];
      return o?.type === "bundle" && o.publishYoutube != null;
    });
  }, [nodes, lastOutputs]);

  const canPublishYoutube = youtubePublishCandidates.length > 0;

  const [youtubePublishTargetId, setYoutubePublishTargetId] = useState<string | null>(null);
  useEffect(() => {
    if (youtubePublishCandidates.length === 0) {
      setYoutubePublishTargetId(null);
      return;
    }
    setYoutubePublishTargetId((prev) =>
      prev && youtubePublishCandidates.some((c) => c.id === prev)
        ? prev
        : youtubePublishCandidates[0]!.id,
    );
  }, [youtubePublishCandidates]);

  const importRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!storageHydrated) return;
    const handle = window.setTimeout(() => {
      void saveNow();
    }, 1400);
    return () => window.clearTimeout(handle);
  }, [storageHydrated, saveNow]);

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
    setStatus("Running…");
    setLastOutputs(null);
    setLiveOutputs({});
    setRunPhase("running");
    setActiveNodeId(null);
    try {
      const workflowNodes = rfNodesToWorkflow(nodes);
      const outputs = await runWorkflowDAG(
        workflowNodes,
        rfEdgesToWorkflow(edges),
        {
          onProgress: (p) => setStatus(p.message ?? p.phase),
          onNodeComplete: (e) => {
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
      void persistWorkflowRunArtifacts(
        workflowId,
        workflowName,
        workflowNodes,
        outputs,
      ).then(({ count }) => {
        if (count > 0) {
          setStatus(
            `Run finished — saved ${count} file(s) to this browser (IndexedDB)`,
          );
        }
      });
    } catch (error) {
      setRunPhase("error");
      setLiveOutputs(null);
      setLastOutputs(null);
      setStatus(wrapError(error).message);
    }
  };

  const downloadAllGenerated = useCallback(async () => {
    if (!lastOutputs) {
      setStatus("Run the workflow first.");
      return;
    }
    setStatus("Building ZIP of all media…");
    try {
      const blob = await zipRuntimeOutputs(
        lastOutputs,
        workflowName.replace(/\s+/g, "-").toLowerCase() || "workflow",
      );
      const slug = workflowName.replace(/\s+/g, "-").toLowerCase();
      saveAs(blob, `${slug}-all-media.zip`);
      setStatus("Downloaded all media");
    } catch {
      setStatus("Could not build media ZIP.");
    }
  }, [lastOutputs, workflowName]);

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

  const publishMeta = async () => {
    if (!lastOutputs) {
      setStatus("Run the workflow first.");
      return;
    }
    const exportNode = metaPublishTargetId
      ? nodes.find((n) => n.id === metaPublishTargetId)
      : undefined;
    const resolved =
      exportNode &&
      exportNode.data.kind === "platformExport" &&
      (exportNode.data.platform === "facebook" || exportNode.data.platform === "instagram")
        ? exportNode
        : metaPublishCandidates[0];

    if (!resolved || resolved.data.kind !== "platformExport") {
      setStatus("Select Facebook or Instagram, choose a Page on the export node, then run.");
      return;
    }
    const out = lastOutputs[resolved.id];
    if (out?.type !== "bundle" || !out.publish) {
      setStatus("Nothing to publish — run the workflow again.");
      return;
    }
    setStatus("Publishing…");
    try {
      const res = await fetch("/api/publish/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: resolved.data.platform,
          pageId: resolved.data.metaPageId!,
          imageUrls: out.publish.imageUrls,
          caption: out.publish.caption,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        permalink?: string | null;
        ok?: boolean;
        carousel?: boolean;
        reqId?: string;
      };
      if (!res.ok) {
        setStatus(body.error ?? "Publish failed.");
        return;
      }
      const link = body.permalink ? ` ${body.permalink}` : "";
      const carouselNote = body.carousel ? " (carousel)" : "";
      setStatus(`Published to ${resolved.data.platform}${carouselNote}.${link}`);
    } catch {
      setStatus("Publish request failed.");
    }
  };

  const publishYoutube = async () => {
    if (!lastOutputs) {
      setStatus("Run the workflow first.");
      return;
    }
    const exportNode = youtubePublishTargetId
      ? nodes.find((n) => n.id === youtubePublishTargetId)
      : undefined;
    const resolved =
      exportNode &&
      exportNode.data.kind === "platformExport" &&
      exportNode.data.platform === "youtube"
        ? exportNode
        : youtubePublishCandidates[0];

    if (!resolved || resolved.data.kind !== "platformExport") {
      setStatus("Set platform to YouTube, wire a public https video URL, then run.");
      return;
    }
    const out = lastOutputs[resolved.id];
    if (out?.type !== "bundle" || !out.publishYoutube) {
      setStatus("Nothing to upload — run workflow with a remote https video on the video handle.");
      return;
    }
    const { videoUrl, title, description } = out.publishYoutube;
    setStatus("Uploading to YouTube…");
    try {
      const res = await fetch("/api/publish/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl,
          title,
          description,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        watchUrl?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        setStatus(body.error ?? "YouTube upload failed.");
        return;
      }
      setStatus(body.watchUrl ? `YouTube: ${body.watchUrl}` : "Uploaded to YouTube.");
    } catch {
      setStatus("YouTube upload request failed.");
    }
  };

  return (
    <>
    <WorkflowRunProvider value={runContextValue}>
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm">
        <div className="mr-auto flex min-w-[200px] flex-1 flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Editor
          </label>
          <input
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm text-card-foreground"
          />
        </div>
        <div className="flex flex-1 flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Library
            </span>
            <div className="flex items-center gap-1">
              <select
                className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground"
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
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent"
            onClick={() => void removeFromLibrary(workflowId)}
          >
            Delete current
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => void runGraph()}
          >
            Run workflow
          </button>
          <button
            type="button"
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!lastOutputs}
            title="Zip all generated images, videos, inputs, and export files from the last run"
            onClick={() => void downloadAllGenerated()}
          >
            Download all media
          </button>
          <button
            type="button"
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent"
            onClick={() => void downloadZip()}
          >
            Download ZIP
          </button>
          {metaPublishCandidates.length > 1 ? (
            <select
              className="max-w-[160px] rounded-md border border-border bg-card px-2 py-1 text-[10px] text-card-foreground"
              value={metaPublishTargetId ?? ""}
              onChange={(e) => setMetaPublishTargetId(e.target.value || null)}
              title="Which Platform export node to post from"
            >
              {metaPublishCandidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.data.kind === "platformExport" ? n.data.label : n.id}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={!canPublishMeta}
            title={
              canPublishMeta
                ? "Post images to the selected Page or Instagram (2+ https images = IG carousel)"
                : "Run with Facebook/Instagram export, select a Page, and use https image URLs (from generation)."
            }
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void publishMeta()}
          >
            Publish to Meta
          </button>
          {youtubePublishCandidates.length > 1 ? (
            <select
              className="max-w-[160px] rounded-md border border-border bg-card px-2 py-1 text-[10px] text-card-foreground"
              value={youtubePublishTargetId ?? ""}
              onChange={(e) => setYoutubePublishTargetId(e.target.value || null)}
              title="Which YouTube export node to upload from"
            >
              {youtubePublishCandidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.data.kind === "platformExport" ? n.data.label : n.id}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={!canPublishYoutube}
            title={
              canPublishYoutube
                ? "Upload the wired https video to your connected YouTube channel (demo size limits apply)."
                : "YouTube: wire the bottom (video) handle to a remote https MP4, connect YouTube, then run."
            }
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void publishYoutube()}
          >
            Publish to YouTube
          </button>
          <Link
            href="/settings/connections"
            className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-card-foreground hover:bg-accent"
          >
            Social accounts
          </Link>
          <ThemeToggle />
          <div
            className="hidden max-w-[220px] flex-col gap-0.5 text-[9px] leading-tight text-muted-foreground lg:flex"
            title="Wires must match pin types (text / image / video)"
          >
            <span className="font-semibold uppercase tracking-wide text-muted-foreground/90">
              Pins
            </span>
            <span>
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />{" "}
              Text ·{" "}
              <span className="inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" />{" "}
              Image ·{" "}
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500 align-middle" />{" "}
              Video
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <WorkflowAgentPanel
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
            fitView
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
        {status ? <span className="text-foreground">{status}</span> : <span>Idle</span>}
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
