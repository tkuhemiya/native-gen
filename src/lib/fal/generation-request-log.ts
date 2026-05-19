/** Server-side console logging for fal generation proxy routes. */

const PREFIX = "[native-gen:fal]";

export function truncateForLog(text: string, max = 600): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}… (${t.length} chars total)`;
}

/** Summarize https URLs or data: blobs without dumping base64 into logs. */
export function summarizeMediaRef(url: string): string {
  if (url.startsWith("data:")) {
    const semi = url.indexOf(";");
    const mime = semi > 5 ? url.slice(5, semi) : "unknown";
    return `data:${mime} (${url.length} chars)`;
  }
  try {
    const u = new URL(url);
    const path =
      u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return url.length > 96 ? `${url.slice(0, 96)}…` : url;
  }
}

export function summarizeMediaRefs(urls: string[]): string[] {
  return urls.map(summarizeMediaRef);
}

type LogMeta = {
  logNodeId?: string;
  logLabel?: string;
};

function metaFields(meta?: LogMeta): Record<string, string> {
  if (!meta?.logNodeId && !meta?.logLabel) return {};
  return {
    ...(meta.logNodeId ? { nodeId: meta.logNodeId } : {}),
    ...(meta.logLabel ? { label: meta.logLabel } : {}),
  };
}

export function logFalGenerationRequest(
  intent: string,
  details: Record<string, unknown>,
  meta?: LogMeta,
): void {
  console.info(`${PREFIX} request`, {
    intent,
    ...metaFields(meta),
    ...details,
  });
}

export function logFalGenerationSuccess(
  intent: string,
  details: Record<string, unknown>,
  meta?: LogMeta,
): void {
  console.info(`${PREFIX} success`, {
    intent,
    ...metaFields(meta),
    ...details,
  });
}

export function logFalGenerationError(
  intent: string,
  message: string,
  meta?: LogMeta,
): void {
  console.warn(`${PREFIX} error`, {
    intent,
    ...metaFields(meta),
    message,
  });
}
