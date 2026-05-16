"use client";

import type { SocialAccountsBlob } from "./types";
import {
  OAUTH_MERGE_SESSION_KEY,
  SOCIAL_LOCAL_STORAGE_KEY,
} from "./social-blob-codec";

export function readBrowserSocialBlob(): SocialAccountsBlob {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SOCIAL_LOCAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as SocialAccountsBlob;
  } catch {
    return {};
  }
}

export function writeBrowserSocialBlob(blob: SocialAccountsBlob): void {
  if (typeof window === "undefined") return;
  try {
    const keys = Object.keys(blob).length;
    if (!keys) {
      localStorage.removeItem(SOCIAL_LOCAL_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SOCIAL_LOCAL_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* quota / private mode */
  }
}

/** Call immediately before navigating to Google/Meta OAuth start routes so the HTML bridge can merge providers. */
export function stashOAuthMergeBase(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      OAUTH_MERGE_SESSION_KEY,
      JSON.stringify(readBrowserSocialBlob()),
    );
  } catch {
    /* ignore */
  }
}
