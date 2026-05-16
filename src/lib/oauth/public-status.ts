import type { SocialAccountsBlob } from "./types";

export type PublicAccountsStatus = {
  google:
    | { connected: true; channelTitle: string | null; channelId: string | null }
    | { connected: false };
  meta:
    | {
        connected: true;
        userName: string | null;
        tokenExpiresAt: string | null;
        pages: { id: string; name: string; instagramUsername: string | null }[];
      }
    | { connected: false };
};

export function socialBlobToPublicStatus(blob: SocialAccountsBlob): PublicAccountsStatus {
  return {
    google: blob.google
      ? {
          connected: true,
          channelTitle: blob.google.channelTitle ?? null,
          channelId: blob.google.channelId ?? null,
        }
      : { connected: false },
    meta: blob.meta
      ? {
          connected: true,
          userName: blob.meta.userName ?? null,
          tokenExpiresAt: blob.meta.userTokenExpiresAt ?? null,
          pages: blob.meta.pages.map((p) => ({
            id: p.id,
            name: p.name,
            instagramUsername: p.instagramUsername ?? null,
          })),
        }
      : { connected: false },
  };
}
