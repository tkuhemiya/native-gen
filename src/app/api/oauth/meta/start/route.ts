import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { oauthPublicBaseUrl } from "@/lib/oauth/base-url";

const CSRF_COOKIE = "ng_csrf_oauth_meta";

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

export async function GET(request: NextRequest) {
  const appId = process.env.META_APP_ID;
  const base = oauthPublicBaseUrl(request);
  const redirectUri = `${base}/api/oauth/meta/callback`;

  if (!appId || !process.env.META_APP_SECRET) {
    return NextResponse.redirect(
      `${base}/settings/connections?error=meta_not_configured`,
    );
  }

  const state = randomBytes(24).toString("hex");
  const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set(CSRF_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 15,
  });
  return res;
}
