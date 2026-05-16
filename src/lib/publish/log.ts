import { randomUUID } from "node:crypto";

export type PublishLogLevel = "info" | "warn" | "error";

export function publishLog(
  level: PublishLogLevel,
  reqId: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    reqId,
    message,
    ...extra,
  };
  if (level === "error") {
    console.error(JSON.stringify(line));
    return;
  }
  if (level === "warn") {
    console.warn(JSON.stringify(line));
    return;
  }
  console.log(JSON.stringify(line));
}

export function resolveRequestId(request: Request): string {
  return (
    request.headers.get("x-request-id") ??
    request.headers.get("X-Request-Id") ??
    randomUUID()
  );
}
