"use client";

import { encodeSocialAccountsBlob, SOCIAL_ACCOUNTS_HEADER } from "./social-blob-codec";
import { readBrowserSocialBlob } from "./browser-social-storage";

export function socialAccountsFetchHeaders(): HeadersInit {
  return {
    [SOCIAL_ACCOUNTS_HEADER]: encodeSocialAccountsBlob(readBrowserSocialBlob()),
  };
}
