import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeWorkflowDocument } from "./migrate";
import type { RuntimeOutputs } from "./runner";
import type { WorkflowDocument, WorkflowNode } from "./schema";

export type GeneratedMediaRecord = {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  createdAt: string;
  nodeId: string;
  nodeLabel: string;
  nodeKind: string;
  fileName: string;
  /** Original slash path for export bundle files (helps rehydrate ZIP shape). */
  storagePath?: string;
  blob: Blob;
};

/** Structured client-side log row (browser / IndexedDB). */
export type WorkflowDebugLogEntry = {
  id: string;
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  /** JSON-serializable diagnostics (no Blobs). */
  data?: Record<string, unknown>;
};

interface NativeGenDB extends DBSchema {
  workflows: {
    key: string;
    value: WorkflowDocument;
    indexes: { "by-updated": string };
  };
  generatedMedia: {
    key: string;
    value: GeneratedMediaRecord;
    indexes: {
      "by-workflow": string;
      "by-run": string;
      "by-created": string;
    };
  };
  workflowDebugLog: {
    key: string;
    value: WorkflowDebugLogEntry;
    indexes: { "by-ts": string };
  };
}

const DB_NAME = "native-gen";
const DB_VERSION = 3;

const MAX_WORKFLOW_DEBUG_LOG_ROWS = 900;

const LAST_RUN_SUMMARY_KEY = "native-gen-last-run-summary";
/** Tiny text-only mirror (localStorage); binary media stays in IndexedDB. */
const LAST_RUN_TEXT_SNAPSHOT_KEY = "native-gen-last-run-text-snapshot";

/** Remember which workflow was open last session (not “most recently autosaved”). */
const LAST_LOADED_WORKFLOW_ID_KEY = "native-gen-last-loaded-workflow-id";

let dbPromise: Promise<IDBPDatabase<NativeGenDB>> | null = null;

export function getLastRunSummaryJson(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_RUN_SUMMARY_KEY);
}

export function getLastLoadedWorkflowId(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(LAST_LOADED_WORKFLOW_ID_KEY)?.trim();
  return v || null;
}

export function setLastLoadedWorkflowId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_LOADED_WORKFLOW_ID_KEY, id);
}

export function clearLastLoadedWorkflowId(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LAST_LOADED_WORKFLOW_ID_KEY);
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<NativeGenDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("workflows")) {
          const store = db.createObjectStore("workflows", { keyPath: "id" });
          store.createIndex("by-updated", "updatedAt");
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains("generatedMedia")) {
          const gm = db.createObjectStore("generatedMedia", {
            keyPath: "id",
          });
          gm.createIndex("by-workflow", "workflowId");
          gm.createIndex("by-run", "runId");
          gm.createIndex("by-created", "createdAt");
        }
        if (oldVersion < 3 && !db.objectStoreNames.contains("workflowDebugLog")) {
          const lg = db.createObjectStore("workflowDebugLog", { keyPath: "id" });
          lg.createIndex("by-ts", "ts");
        }
      },
    });
  }
  return dbPromise;
}

export async function appendWorkflowDebugLogEntry(
  entry: WorkflowDebugLogEntry,
): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDb();
  const tx = db.transaction("workflowDebugLog", "readwrite");
  await tx.store.add(entry);
  let count = await tx.store.count();
  const idx = tx.store.index("by-ts");
  while (count > MAX_WORKFLOW_DEBUG_LOG_ROWS) {
    const cursor = await idx.openCursor();
    if (!cursor) break;
    await cursor.delete();
    count--;
  }
  await tx.done;
}

export async function loadWorkflowDebugLogEntries(): Promise<
  WorkflowDebugLogEntry[]
> {
  if (typeof window === "undefined") return [];
  const db = await getDb();
  const all = await db.getAll("workflowDebugLog");
  return all.sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function clearWorkflowDebugLogEntries(): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDb();
  await db.clear("workflowDebugLog");
}

export async function saveWorkflowDoc(doc: WorkflowDocument) {
  const db = await getDb();
  await db.put("workflows", doc);
}

export async function loadWorkflowDoc(id: string) {
  const db = await getDb();
  const row = await db.get("workflows", id);
  if (!row) return undefined;
  return normalizeWorkflowDocument(row) ?? undefined;
}

export async function listWorkflowDocs(): Promise<WorkflowDocument[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("workflows", "by-updated");
  return all
    .map((row) => normalizeWorkflowDocument(row))
    .filter((doc): doc is WorkflowDocument => doc != null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function deleteWorkflowDoc(id: string) {
  const db = await getDb();
  await db.delete("workflows", id);
}

/** Persist generated blobs from a finished run for offline gallery / recovery (IndexedDB + small localStorage summary). */
export async function persistWorkflowRunArtifacts(
  workflowId: string,
  workflowName: string,
  nodes: WorkflowNode[],
  outputs: RuntimeOutputs,
): Promise<{ runId: string; count: number }> {
  if (typeof window === "undefined") {
    return { runId: "", count: 0 };
  }

  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const records: GeneratedMediaRecord[] = [];
  const slug =
    workflowName
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/gi, "")
      .slice(0, 48) || "run";

  const push = (r: Omit<GeneratedMediaRecord, "id"> & { id?: string }) => {
    records.push({
      ...r,
      id: r.id ?? crypto.randomUUID(),
    });
  };

  for (const [nodeId, out] of Object.entries(outputs)) {
    const node = byId.get(nodeId);
    const nodeLabel = node?.data.label?.trim() || nodeId.slice(0, 8);
    const nodeKind = node?.data.kind ?? "unknown";

    if (out.type === "image") {
      try {
        const res = await fetch(out.url);
        if (res.ok) {
          const blob = await res.blob();
          const ext = res.headers.get("content-type")?.includes("png")
            ? "png"
            : "jpg";
          push({
            runId,
            workflowId,
            workflowName,
            createdAt,
            nodeId,
            nodeLabel,
            nodeKind,
            fileName: `${slug}-${nodeId.slice(0, 8)}-generated.${ext}`,
            blob,
          });
        }
      } catch {
        /* CORS / offline */
      }
    } else if (out.type === "generation") {
      if (out.text?.trim()) {
        push({
          runId,
          workflowId,
          workflowName,
          createdAt,
          nodeId,
          nodeLabel,
          nodeKind,
          fileName: `${slug}-${nodeId.slice(0, 8)}-generated-copy.txt`,
          blob: new Blob([out.text], { type: "text/plain;charset=utf-8" }),
        });
      }
      if (out.imageUrl) {
        try {
          const res = await fetch(out.imageUrl);
          if (res.ok) {
            const ext = res.headers.get("content-type")?.includes("png")
              ? "png"
              : "jpg";
            push({
              runId,
              workflowId,
              workflowName,
              createdAt,
              nodeId,
              nodeLabel,
              nodeKind,
              fileName: `${slug}-${nodeId.slice(0, 8)}-generated.${ext}`,
              blob: await res.blob(),
            });
          }
        } catch {
          /* skip */
        }
      }
    } else if (out.type === "video") {
      try {
        const res = await fetch(out.url);
        if (res.ok) {
          const ext = res.headers.get("content-type")?.includes("webm") ? "webm" : "mp4";
          push({
            runId,
            workflowId,
            workflowName,
            createdAt,
            nodeId,
            nodeLabel,
            nodeKind,
            fileName: `${slug}-${nodeId.slice(0, 8)}-generated-video.${ext}`,
            blob: await res.blob(),
          });
        }
      } catch {
        /* CORS / offline */
      }
    } else if (out.type === "mediaInput") {
      if (out.text.trim()) {
        push({
          runId,
          workflowId,
          workflowName,
          createdAt,
          nodeId,
          nodeLabel,
          nodeKind,
          fileName: `${slug}-${nodeId.slice(0, 8)}-copy.txt`,
          blob: new Blob([out.text], { type: "text/plain;charset=utf-8" }),
        });
      }
      let i = 0;
      for (const url of out.imageUrls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            push({
              runId,
              workflowId,
              workflowName,
              createdAt,
              nodeId,
              nodeLabel,
              nodeKind,
              fileName: `${slug}-${nodeId.slice(0, 8)}-input-img-${i}.png`,
              blob: await res.blob(),
            });
          }
        } catch {
          /* skip */
        }
        i++;
      }
    } else if (out.type === "bundle") {
      for (const f of out.files) {
        const safeName = f.path.replace(/^\/+/, "").replace(/\//g, "_");
        push({
          runId,
          workflowId,
          workflowName,
          createdAt,
          nodeId,
          nodeLabel,
          nodeKind,
          fileName: `${slug}-${safeName}`,
          storagePath: f.path.replace(/^\/+/, ""),
          blob: f.blob,
        });
      }
    }
  }

  if (records.length === 0) {
    try {
      localStorage.removeItem(LAST_RUN_TEXT_SNAPSHOT_KEY);
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem(
        LAST_RUN_SUMMARY_KEY,
        JSON.stringify({
          runId,
          workflowId,
          workflowName,
          createdAt,
          artifactCount: 0,
        }),
      );
    } catch {
      /* quota */
    }
    return { runId, count: 0 };
  }

  const db = await getDb();
  const tx = db.transaction("generatedMedia", "readwrite");
  for (const r of records) {
    await tx.store.add(r);
  }
  await tx.done;

  mirrorTextOutputsToLocalStorage(workflowId, runId, outputs);

  try {
    localStorage.setItem(
      LAST_RUN_SUMMARY_KEY,
      JSON.stringify({
        runId,
        workflowId,
        workflowName,
        createdAt,
        artifactCount: records.length,
      }),
    );
  } catch {
    /* quota */
  }

  return { runId, count: records.length };
}

function mirrorTextOutputsToLocalStorage(
  workflowId: string,
  runId: string,
  outputs: RuntimeOutputs,
): void {
  if (typeof window === "undefined") return;
  const texts: Record<string, string> = {};
  for (const [id, o] of Object.entries(outputs)) {
    if (o.type === "text" && o.value.trim()) texts[id] = o.value;
    else if (o.type === "generation" && o.text?.trim()) texts[id] = o.text;
    else if (o.type === "mediaInput" && o.text.trim()) texts[id] = o.text;
  }
  if (Object.keys(texts).length === 0) return;
  try {
    window.localStorage.setItem(
      LAST_RUN_TEXT_SNAPSHOT_KEY,
      JSON.stringify({
        workflowId,
        runId,
        savedAt: new Date().toISOString(),
        texts,
      }),
    );
  } catch {
    /* quota */
  }
}

/** Latest persisted run for this workflow (by `createdAt`), or null. */
export async function getLatestRunArtifactRecordsForWorkflow(
  workflowId: string,
): Promise<GeneratedMediaRecord[] | null> {
  if (typeof window === "undefined") return null;
  const db = await getDb();
  const rows = await db.getAllFromIndex("generatedMedia", "by-workflow", workflowId);
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const latestRunId = rows[0]!.runId;
  return rows.filter((r) => r.runId === latestRunId);
}

/**
 * Rebuild {@link RuntimeOutputs} from IndexedDB blobs (object URLs) for the current graph.
 * Does not restore `publish` metadata on bundle outputs.
 */
export async function rehydrateRuntimeOutputsFromArtifacts(
  records: GeneratedMediaRecord[],
  nodes: WorkflowNode[],
): Promise<RuntimeOutputs | null> {
  if (records.length === 0) return null;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const byNode = new Map<string, GeneratedMediaRecord[]>();
  for (const r of records) {
    const list = byNode.get(r.nodeId) ?? [];
    list.push(r);
    byNode.set(r.nodeId, list);
  }

  const out: RuntimeOutputs = {};

  for (const [nodeId, recs] of byNode) {
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const kind = (recs[0]?.nodeKind ?? node.data.kind) as string;

    if (kind === "mediaInput") {
      let text = "";
      const imageUrls: string[] = [];
      const sorted = [...recs].sort((a, b) => a.fileName.localeCompare(b.fileName));
      for (const r of sorted) {
        if (r.fileName.endsWith("-generated-copy.txt")) continue;
        if (r.fileName.endsWith("-copy.txt")) {
          text = await r.blob.text();
        } else if (r.fileName.includes("-input-img-")) {
          imageUrls.push(URL.createObjectURL(r.blob));
        }
      }
      out[nodeId] = { type: "mediaInput", text, imageUrls };
      continue;
    }

    if (kind === "generationBlock") {
      let text: string | undefined;
      let imageUrl: string | undefined;
      for (const r of recs) {
        if (r.fileName.includes("-generated-copy.txt")) {
          text = await r.blob.text();
        } else if (/\.(jpe?g|png)$/i.test(r.fileName) && r.fileName.includes("-generated.")) {
          imageUrl = URL.createObjectURL(r.blob);
        }
      }
      out[nodeId] = { type: "generation", text, imageUrl };
      continue;
    }

    if (kind === "videoBlock") {
      let url: string | undefined;
      for (const r of recs) {
        if (r.fileName.includes("-generated-video.")) {
          url = URL.createObjectURL(r.blob);
        }
      }
      if (url) {
        out[nodeId] = { type: "video", url };
      }
      continue;
    }

    if (kind === "platformExport") {
      const files: { path: string; blob: Blob }[] = [];
      for (const r of recs) {
        files.push({
          path: r.storagePath && r.storagePath.length > 0 ? r.storagePath : r.fileName,
          blob: r.blob,
        });
      }
      if (files.length > 0) {
        out[nodeId] = { type: "bundle", files };
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}
