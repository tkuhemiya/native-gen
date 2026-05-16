import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { oauthPublicBaseUrl } from "@/lib/oauth/base-url";
import { oauthBridgeHtmlResponse } from "@/lib/oauth/oauth-bridge-html";
import type { SocialAccountsBlob } from "@/lib/oauth/types";

const CSRF_COOKIE = "ng_csrf_oauth_google";

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

type YoutubeChannelList = {
  items?: { id: string; snippet?: { title?: string } }[];
};

export async function GET(request: NextRequest) {
  const base = oauthPublicBaseUrl(request);
  const jar = await cookies();

  const deny = (code: string) => {
    const res = NextResponse.redirect(
      `${base}/settings/connections?error=${encodeURIComponent(code)}`,
    );
    res.cookies.set(CSRF_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  };

  const oauthErr = request.nextUrl.searchParams.get("error");
  if (oauthErr) {
    return deny(`google_${oauthErr}`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expected = jar.get(CSRF_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) {
    return deny("google_invalid_state");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return deny("google_not_configured");
  }

  const redirectUri = `${base}/api/oauth/google/callback`;
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokenRes.ok || tokenJson.error || !tokenJson.refresh_token) {
    return deny("google_token_exchange");
  }

  let channelId: string | undefined;
  let channelTitle: string | undefined;
  if (tokenJson.access_token) {
    const chRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
    );
    if (chRes.ok) {
      const list = (await chRes.json()) as YoutubeChannelList;
      const first = list.items?.[0];
      if (first) {
        channelId = first.id;
        channelTitle = first.snippet?.title;
      }
    }
  }

  const partial: SocialAccountsBlob = {
    google: {
      refreshToken: tokenJson.refresh_token,
      scope: tokenJson.scope,
      channelId,
      channelTitle,
      connectedAt: new Date().toISOString(),
    },
  };

  const res = oauthBridgeHtmlResponse({
    redirectBase: base,
    partialBlob: partial,
    connectedQuery: "google",
  });
  res.cookies.set(CSRF_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
