import type { NextResponse } from "next/server";
import type { SocialAccountsBlob } from "./types";
import { sealPayload, unsealPayload } from "./crypto";

export const SOCIAL_COOKIE = "ng_social_v1";
const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 55,
};

export function readSocialBlob(cookieValue: string | undefined): SocialAccountsBlob {
  if (!cookieValue) return {};
  return unsealPayload<SocialAccountsBlob>(cookieValue) ?? {};
}

export function setSocialCookieOnResponse(
  res: NextResponse,
  blob: SocialAccountsBlob,
): NextResponse {
  const keys = Object.keys(blob).length;
  if (keys === 0) {
    res.cookies.set(SOCIAL_COOKIE, "", { ...cookieBase, maxAge: 0 });
    return res;
  }
  res.cookies.set(SOCIAL_COOKIE, sealPayload(blob), cookieBase);
  return res;
}
