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
  blob: Blob;
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
}

const DB_NAME = "native-gen";
const DB_VERSION = 2;

const LAST_RUN_SUMMARY_KEY = "native-gen-last-run-summary";

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
      },
    });
  }
  return dbPromise;
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
    } else if (out.type === "video") {
      try {
        const res = await fetch(out.url);
        if (res.ok) {
          push({
            runId,
            workflowId,
            workflowName,
            createdAt,
            nodeId,
            nodeLabel,
            nodeKind,
            fileName: `${slug}-${nodeId.slice(0, 8)}-video.mp4`,
            blob: await res.blob(),
          });
        }
      } catch {
        /* skip */
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
      let v = 0;
      for (const url of out.videoUrls) {
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
              fileName: `${slug}-${nodeId.slice(0, 8)}-input-vid-${v}.webm`,
              blob: await res.blob(),
            });
          }
        } catch {
          /* skip */
        }
        v++;
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
          blob: f.blob,
        });
      }
    }
  }

  if (records.length === 0) {
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
