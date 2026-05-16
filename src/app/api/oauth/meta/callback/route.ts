import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { oauthPublicBaseUrl } from "@/lib/oauth/base-url";
import { loadSocialAccountsBlob, commitSocialAccountsBlob } from "@/lib/oauth/server-store";
import { sealPayload } from "@/lib/oauth/crypto";
import type { MetaPageStored, SocialAccountsBlob } from "@/lib/oauth/types";

const CSRF_COOKIE = "ng_csrf_oauth_meta";
const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_PAGES = 12;

type MetaTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: { message?: string; type?: string; code?: number };
};

type MetaMe = { id?: string; name?: string; error?: { message?: string } };

type MetaAccountsResponse = {
  data?: Array<{
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username?: string };
  }>;
  error?: { message?: string };
};

async function fetchMetaJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return res.json() as Promise<T>;
}

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

  if (request.nextUrl.searchParams.get("error")) {
    return deny("meta_denied");
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expected = jar.get(CSRF_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) {
    return deny("meta_invalid_state");
  }

  try {
    sealPayload({});
  } catch {
    return deny("oauth_secret");
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return deny("meta_not_configured");
  }

  const redirectUri = `${base}/api/oauth/meta/callback`;

  const shortUrl = new URL(`${GRAPH}/oauth/access_token`);
  shortUrl.searchParams.set("client_id", appId);
  shortUrl.searchParams.set("client_secret", appSecret);
  shortUrl.searchParams.set("redirect_uri", redirectUri);
  shortUrl.searchParams.set("code", code);

  const shortJson = await fetchMetaJson<MetaTokenResponse>(shortUrl.toString());
  const shortToken = shortJson.access_token;
  if (!shortToken || shortJson.error) {
    return deny("meta_token_exchange");
  }

  const longUrl = new URL(`${GRAPH}/oauth/access_token`);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken);

  const longJson = await fetchMetaJson<MetaTokenResponse>(longUrl.toString());
  const userToken = longJson.access_token ?? shortToken;
  if (!userToken) {
    return deny("meta_long_lived");
  }

  const userTokenExpiresAt =
    typeof longJson.expires_in === "number"
      ? new Date(Date.now() + longJson.expires_in * 1000).toISOString()
      : undefined;

  const meUrl = new URL(`${GRAPH}/me`);
  meUrl.searchParams.set("fields", "id,name");
  meUrl.searchParams.set("access_token", userToken);
  const meJson = await fetchMetaJson<MetaMe>(meUrl.toString());
  const userId = meJson.id;
  if (!userId || meJson.error) {
    return deny("meta_me");
  }

  const accountsUrl = new URL(`${GRAPH}/me/accounts`);
  accountsUrl.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username}",
  );
  accountsUrl.searchParams.set("access_token", userToken);
  const accountsJson = await fetchMetaJson<MetaAccountsResponse>(accountsUrl.toString());
  if (accountsJson.error) {
    return deny("meta_pages");
  }

  const pages: MetaPageStored[] = (accountsJson.data ?? []).slice(0, MAX_PAGES).map((p) => ({
    id: p.id,
    name: p.name,
    pageAccessToken: p.access_token,
    instagramUserId: p.instagram_business_account?.id,
    instagramUsername: p.instagram_business_account?.username,
  }));

  const existing = await loadSocialAccountsBlob();
  const next: SocialAccountsBlob = {
    ...existing,
    meta: {
      userId,
      userName: meJson.name,
      userAccessToken: userToken,
      userTokenExpiresAt,
      pages,
      connectedAt: new Date().toISOString(),
    },
  };

  const res = NextResponse.redirect(`${base}/settings/connections?connected=meta`);
  res.cookies.set(CSRF_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  await commitSocialAccountsBlob(res, next);
  return res;
}
