import type { SocialAccountsBlob } from "./types";

/** Sent on fetch calls so Route Handlers can read tokens without server-side persistence. */
export const SOCIAL_ACCOUNTS_HEADER = "x-native-gen-social-accounts";

export const SOCIAL_LOCAL_STORAGE_KEY = "native_gen.social_accounts.v1";

/** Snapshot stored before redirecting to Google/Meta OAuth so callbacks can merge providers. */
export const OAUTH_MERGE_SESSION_KEY = "ng_oauth_pending_merge.v1";

function utf8ToBase64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeSocialAccountsBlob(blob: SocialAccountsBlob): string {
  return utf8ToBase64(JSON.stringify(blob));
}

export function decodeSocialAccountsBlobHeader(encoded: string | null): SocialAccountsBlob | null {
  if (!encoded?.trim()) return null;
  try {
    const parsed = JSON.parse(base64ToUtf8(encoded.trim())) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SocialAccountsBlob;
  } catch {
    return null;
  }
}
