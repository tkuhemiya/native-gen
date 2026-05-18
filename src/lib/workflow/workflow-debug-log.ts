import type { WorkflowDebugLogEntry } from "./storage";

const PREFIX = "[native-gen:workflow]";
const MEMORY_TAIL = 400;

const memoryLog: WorkflowDebugLogEntry[] = [];

function sanitizeData(
  data?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (v instanceof Blob) out[k] = "[Blob]";
    else if (typeof v === "string") {
      out[k] =
        v.length > 2400 ? `${v.slice(0, 2400)}…(${v.length} chars)` : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (typeof v === "object") {
      try {
        out[k] = JSON.stringify(v).slice(0, 4000);
      } catch {
        out[k] = String(v);
      }
    } else {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Browser-only: console + IndexedDB ring buffer (see storage upgrade v3). */
export function logWorkflow(
  level: WorkflowDebugLogEntry["level"],
  scope: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;

  const safeData = sanitizeData(data);
  const entry: WorkflowDebugLogEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(safeData ? { data: safeData } : {}),
  };

  memoryLog.push(entry);
  while (memoryLog.length > MEMORY_TAIL) memoryLog.shift();

  const consoleFn =
    level === "error"
      ? /* Next.js dev overlay often attaches to console.error even outside render; keep diagnostics visible without false "crashes". */
        console.warn
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.info;

  /** Next/Turbopack dev overlays often cannot clone arbitrary objects → second arg renders as `{}`. */
  let inlineDetails = "";
  if (safeData && Object.keys(safeData).length > 0 && (level === "error" || level === "warn")) {
    try {
      const json = JSON.stringify(safeData);
      inlineDetails = `\n${json.length > 8000 ? `${json.slice(0, 8000)}… (${json.length} chars)` : json}`;
    } catch {
      inlineDetails = "\n(unserializable log data)";
    }
  }

  if (safeData && Object.keys(safeData).length > 0 && !inlineDetails) {
    consoleFn(`${PREFIX} [${scope}] ${message}`, safeData);
  } else {
    consoleFn(`${PREFIX} [${scope}] ${message}${inlineDetails}`);
  }

  void import("./storage")
    .then(({ appendWorkflowDebugLogEntry }) =>
      appendWorkflowDebugLogEntry(entry),
    )
    .catch(() => {
      console.warn(PREFIX, "[workflow-debug-log]", "IndexedDB append failed");
    });
}

export function getWorkflowMemoryLogTail(): readonly WorkflowDebugLogEntry[] {
  return memoryLog;
}

/** Newest in-memory lines not guaranteed persisted yet; merges with IndexedDB by id. */
export async function buildWorkflowDebugLogExportJson(): Promise<string> {
  const { loadWorkflowDebugLogEntries } = await import("./storage");
  const persisted = await loadWorkflowDebugLogEntries();
  const byId = new Map<string, WorkflowDebugLogEntry>();
  for (const e of persisted) byId.set(e.id, e);
  for (const e of memoryLog) byId.set(e.id, e);
  const sorted = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  return JSON.stringify(sorted, null, 2);
}

export async function clearPersistedWorkflowLogs(): Promise<void> {
  const { clearWorkflowDebugLogEntries } = await import("./storage");
  await clearWorkflowDebugLogEntries();
}

export function clearWorkflowMemoryLog(): void {
  memoryLog.length = 0;
}
