import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readSocialBlob, setSocialCookieOnResponse, SOCIAL_COOKIE } from "@/lib/oauth/cookies";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    provider?: string;
  } | null;
  const provider = body?.provider;
  if (provider !== "google" && provider !== "meta") {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  const jar = await cookies();
  const blob = readSocialBlob(jar.get(SOCIAL_COOKIE)?.value);
  const next = { ...blob };
  if (provider === "google") {
    delete next.google;
  } else {
    delete next.meta;
  }

  const res = NextResponse.json({ ok: true });
  setSocialCookieOnResponse(res, next);
  return res;
}
