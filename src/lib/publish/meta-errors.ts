/** Map Meta / Instagram error strings to short, demo-friendly hints. */

const PATTERNS: { test: RegExp; hint: string }[] = [
  {
    test: /permission|OAuthException/i,
    hint: "Missing Meta permission — reconnect Social accounts (you may need App Review for production users).",
  },
  {
    test: /photo|image|Invalid parameter|url/i,
    hint: "Image URL rejected — use a direct https image (JPEG/PNG). Try a fresh Flux URL; no local data URLs.",
  },
  {
    test: /video|format|container/i,
    hint: "Media format issue — for carousel, Meta may require all JPEG/PNG of similar aspect ratio.",
  },
  {
    test: /rate|limit|spam/i,
    hint: "Meta rate limit — wait a minute and try again.",
  },
  {
    test: /session|expired|token/i,
    hint: "Meta session expired — disconnect and reconnect under Social accounts.",
  },
  {
    test: /carousel|children|CAROUSEL/i,
    hint: "Carousel failed — try a single image or reduce the number of images (max 10).",
  },
];

export function humanizeMetaPublishError(raw: string): string {
  const t = raw.trim();
  if (!t) return "Unknown Meta error.";
  for (const { test, hint } of PATTERNS) {
    if (test.test(t)) {
      return `${t} — ${hint}`;
    }
  }
  return t;
}
