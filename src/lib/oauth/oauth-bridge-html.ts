import { NextResponse } from "next/server";

import type { SocialAccountsBlob } from "./types";
import {
  OAUTH_MERGE_SESSION_KEY,
  SOCIAL_LOCAL_STORAGE_KEY,
} from "./social-blob-codec";

/**
 * OAuth callbacks land here without access to localStorage; return HTML that merges session snapshot + new tokens.
 */
export function oauthBridgeHtmlResponse(opts: {
  redirectBase: string;
  partialBlob: SocialAccountsBlob;
  connectedQuery: "google" | "meta";
}): NextResponse {
  const target = `${opts.redirectBase.replace(/\/$/, "")}/settings/connections?connected=${opts.connectedQuery}`;
  const partialJson = JSON.stringify(opts.partialBlob);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Saving connection</title>
</head>
<body>
<script>
(function () {
  var partial = ${partialJson};
  var mergeKey = ${JSON.stringify(OAUTH_MERGE_SESSION_KEY)};
  var storageKey = ${JSON.stringify(SOCIAL_LOCAL_STORAGE_KEY)};
  var nextUrl = ${JSON.stringify(target)};
  var existing = {};
  try {
    var raw = sessionStorage.getItem(mergeKey);
    if (raw) existing = JSON.parse(raw) || {};
  } catch (e) {}
  try { sessionStorage.removeItem(mergeKey); } catch (e) {}
  var merged = Object.assign({}, existing);
  if (partial.google) merged.google = partial.google;
  if (partial.meta) merged.meta = partial.meta;
  try {
    localStorage.setItem(storageKey, JSON.stringify(merged));
  } catch (e) {
    location.replace(${JSON.stringify(`${opts.redirectBase.replace(/\/$/, "")}/settings/connections?error=storage_blocked`)});
    return;
  }
  location.replace(nextUrl);
})();
</script>
<noscript><meta http-equiv="refresh" content="0;url=${target.replace(/"/g, "&quot;")}"/></noscript>
<p>Saving connection… <a href="${target.replace(/"/g, "&quot;").replace(/</g, "&lt;")}">Continue</a></p>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
