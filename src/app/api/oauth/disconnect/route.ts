import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { commitSocialAccountsBlob, loadSocialAccountsBlob } from "@/lib/oauth/server-store";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    provider?: string;
  } | null;
  const provider = body?.provider;
  if (provider !== "google" && provider !== "meta") {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  const blob = await loadSocialAccountsBlob();
  const next = { ...blob };
  if (provider === "google") {
    delete next.google;
  } else {
    delete next.meta;
  }

  const res = NextResponse.json({ ok: true });
  await commitSocialAccountsBlob(res, next);
  return res;
}
