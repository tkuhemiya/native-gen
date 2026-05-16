"use client";

import Link from "next/link";
import { useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import {
  readBrowserSocialBlob,
  stashOAuthMergeBase,
  writeBrowserSocialBlob,
} from "@/lib/oauth/browser-social-storage";
import { socialBlobToPublicStatus, type PublicAccountsStatus } from "@/lib/oauth/public-status";

const ERROR_LABELS: Record<string, string> = {
  google_not_configured: "YouTube / Google sign-in is not configured on this server (missing OAuth credentials).",
  meta_not_configured: "Facebook / Instagram sign-in is not configured on this server (missing Meta app credentials).",
  storage_blocked:
    "Could not save tokens in this browser (private mode, blocked storage, or quota). Allow site data for localhost / your domain.",
  google_invalid_state: "Google sign-in failed (invalid session). Try again.",
  google_token_exchange: "Could not complete Google sign-in. Try again or re-connect your app in Google Cloud.",
  meta_invalid_state: "Meta sign-in failed (invalid session). Try again.",
  meta_token_exchange: "Could not exchange Meta authorization code.",
  meta_long_lived: "Could not obtain a long-lived Meta access token.",
  meta_me: "Could not read your Meta profile after sign-in.",
  meta_pages: "Could not list Facebook Pages. Grant Page access or try a different account.",
  meta_denied: "Facebook / Instagram sign-in was cancelled or denied.",
  google_access_denied: "YouTube / Google sign-in was cancelled or denied.",
};

function resolveError(code: string): string {
  return ERROR_LABELS[code] ?? `Something went wrong (${code}).`;
}

export function ConnectionsPanel({
  urlError,
  urlConnected,
}: {
  urlError?: string;
  urlConnected?: string;
}) {
  const [data, setData] = useState<PublicAccountsStatus>(() =>
    socialBlobToPublicStatus(readBrowserSocialBlob()),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "google" | "meta">(null);

  const disconnect = (provider: "google" | "meta") => {
    setActionError(null);
    setBusy(provider);
    try {
      const blob = readBrowserSocialBlob();
      if (provider === "google") delete blob.google;
      else delete blob.meta;
      writeBrowserSocialBlob(blob);
      setData(socialBlobToPublicStatus(blob));
    } catch {
      setActionError("Could not disconnect.");
    } finally {
      setBusy(null);
    }
  };

  const banner = urlError
    ? { kind: "error" as const, text: resolveError(urlError) }
    : urlConnected
      ? {
            kind: "success" as const,
            text:
              urlConnected === "google"
                ? "YouTube account connected."
                : urlConnected === "meta"
                  ? "Facebook / Instagram account connected."
                  : "Connected.",
          }
      : null;

  return (
    <div className="relative mx-auto flex min-h-full max-w-lg flex-col gap-8 px-6 py-12">
      <div className="absolute right-4 top-4 flex items-center gap-3">
        <Link
          href="/"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← Workflow
        </Link>
        <ThemeToggle />
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Social accounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tokens for YouTube and Meta stay in this browser&apos;s{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">localStorage</code> (plaintext JSON).
          Each API request sends them in a header — nothing OAuth-related is stored on the server. Use a trusted
          device; malicious scripts on this origin could read tokens.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Live demo checklist: rehearse on venue Wi‑Fi, keep a short screen recording of Publish working as backup,
          and reconnect Meta if we added posting scopes.
        </p>
      </div>

      {banner?.kind === "error" ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {banner.text}
        </p>
      ) : null}
      {banner?.kind === "success" ? (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {banner.text}
        </p>
      ) : null}

      {actionError ? (
        <p className="text-sm text-destructive">{actionError}</p>
      ) : null}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          YouTube (Google)
        </h2>
        <p className="text-xs text-muted-foreground">
          Uses Google OAuth. Enables uploads and channel metadata with your consent. Requires YouTube Data API v3
          enabled on your Google Cloud project.
        </p>
        {data.google.connected ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-foreground">
              Connected
              {data.google.channelTitle ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {data.google.channelTitle}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              disabled={busy !== null}
              className="self-start rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
              onClick={() => disconnect("google")}
            >
              {busy === "google" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <a
            href="/api/oauth/google/start"
            onClick={() => stashOAuthMergeBase()}
            className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Connect YouTube
          </a>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Facebook &amp; Instagram (Meta)
        </h2>
        <p className="text-xs text-muted-foreground">
          Instagram posts go through the Instagram Graph API: your IG must be a Professional (Business or Creator)
          account linked to a Facebook Page you manage. One Meta login grants Page tokens we use for programmatic
          publishing (single images or carousels). Production traffic usually needs Meta App Review.
        </p>
        <details className="rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium text-foreground">
            Before connecting Instagram
          </summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 leading-relaxed">
            <li>In Instagram: switch to a Professional account if you have not already.</li>
            <li>In Meta Business Suite (or Facebook Pages): create or open a Facebook Page and link that Instagram account.</li>
            <li>In Meta Developer Console: add your Meta app OAuth redirect URLs and scope testers / Pages while in Development mode until App Review completes.</li>
            <li>Use &quot;Connect Facebook &amp; Instagram&quot; below with a user who is admin of the Page and grant Page permissions.</li>
          </ol>
        </details>
        {data.meta.connected ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-foreground">
              Connected
              {data.meta.userName ? (
                <span className="text-muted-foreground"> · {data.meta.userName}</span>
              ) : null}
            </p>
            {data.meta.pages.length > 0 ? (
              <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {data.meta.pages.map((p) => (
                  <li key={p.id}>
                    <span className="text-foreground">{p.name}</span>
                    {p.instagramUsername ? (
                      <span> · @{p.instagramUsername}</span>
                    ) : (
                      <span className="italic"> · no linked Instagram</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No Facebook Pages found for this account.</p>
            )}
            <button
              type="button"
              disabled={busy !== null}
              className="self-start rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
              onClick={() => disconnect("meta")}
            >
              {busy === "meta" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <a
            href="/api/oauth/meta/start"
            onClick={() => stashOAuthMergeBase()}
            className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Connect Facebook &amp; Instagram
          </a>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Redirect URLs for your developer consoles:{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
          …/api/oauth/google/callback
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
          …/api/oauth/meta/callback
        </code>
        . Set <code className="rounded bg-muted px-1 font-mono text-[10px]">NEXT_PUBLIC_APP_URL</code> in
        production so these match exactly.
      </p>
    </div>
  );
}
