import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeWorkflowDocument } from "./migrate";
import type { WorkflowDocument } from "./schema";

interface NativeGenDB extends DBSchema {
  workflows: {
    key: string;
    value: WorkflowDocument;
    indexes: { "by-updated": string };
  };
}

const DB_NAME = "native-gen";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<NativeGenDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<NativeGenDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("workflows", { keyPath: "id" });
        store.createIndex("by-updated", "updatedAt");
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
