import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { readSocialBlob, setSocialCookieOnResponse, SOCIAL_COOKIE } from "@/lib/oauth/cookies";
import { sealPayload, unsealPayload } from "@/lib/oauth/crypto";
import type { SocialAccountsBlob } from "@/lib/oauth/types";

/** Optional file-backed token store (self-hosted). Unset = legacy encrypted cookie only (serverless-friendly). */
const persistPath = () => process.env.NATIVE_GEN_OAUTH_PERSIST_PATH;

export const OAUTH_SID_COOKIE = "ng_oauth_sid";

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 55,
};

async function readAllSessions(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function loadSocialAccountsBlob(): Promise<SocialAccountsBlob> {
  const jar = await cookies();
  const p = persistPath();
  if (p) {
    const abs = path.resolve(p);
    const sid = jar.get(OAUTH_SID_COOKIE)?.value;
    if (sid) {
      const store = await readAllSessions(abs);
      const sealed = store[sid];
      if (sealed) {
        const blob = unsealPayload<SocialAccountsBlob>(sealed);
        if (blob) return blob;
      }
    }
  }
  return readSocialBlob(jar.get(SOCIAL_COOKIE)?.value);
}

/**
 * Persists OAuth blob: file + session cookie when `NATIVE_GEN_OAUTH_PERSIST_PATH` is set,
 * otherwise sets the legacy encrypted `ng_social_v1` cookie.
 */
export async function commitSocialAccountsBlob(
  res: NextResponse,
  blob: SocialAccountsBlob,
): Promise<void> {
  const p = persistPath();
  const jar = await cookies();
  if (p) {
    const abs = path.resolve(p);
    await mkdir(path.dirname(abs), { recursive: true });
    const store = await readAllSessions(abs);
    const sid = jar.get(OAUTH_SID_COOKIE)?.value;
    const hasData = blob.google != null || blob.meta != null;
    if (!hasData) {
      if (sid) delete store[sid];
      await writeFile(abs, JSON.stringify(store, null, 2), "utf8");
      res.cookies.set(OAUTH_SID_COOKIE, "", { ...cookieBase, maxAge: 0 });
      res.cookies.set(SOCIAL_COOKIE, "", { ...cookieBase, maxAge: 0 });
      return;
    }
    const nextSid = sid ?? randomBytes(24).toString("hex");
    store[nextSid] = sealPayload(blob);
    await writeFile(abs, JSON.stringify(store, null, 2), "utf8");
    res.cookies.set(OAUTH_SID_COOKIE, nextSid, cookieBase);
    res.cookies.set(SOCIAL_COOKIE, "", { ...cookieBase, maxAge: 0 });
    return;
  }
  setSocialCookieOnResponse(res, blob);
}
