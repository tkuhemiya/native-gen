import type { NextRequest } from "next/server";

import type { SocialAccountsBlob } from "./types";
import {
  decodeSocialAccountsBlobHeader,
  SOCIAL_ACCOUNTS_HEADER,
} from "./social-blob-codec";

export function loadSocialAccountsFromRequest(request: NextRequest | Request): SocialAccountsBlob {
  const raw = request.headers.get(SOCIAL_ACCOUNTS_HEADER);
  return decodeSocialAccountsBlobHeader(raw) ?? {};
}
