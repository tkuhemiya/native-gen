# Social publishing: app review & production checklist

Use this when moving beyond **developer/test** users on Meta or Google/YouTube.

## Meta (Facebook Login + Instagram Graph API)

1. **Business verification** — Complete Meta Business verification if you request advanced permissions at scale.
2. **App Review** — Request only the permissions you use (`pages_manage_posts`, `instagram_content_publish`, `pages_show_list`, etc.). Prepare a **screencast** showing the exact user flow in this app (connect → run workflow → publish).
3. **Data handling** — Document token storage, retention, and deletion when users disconnect. Tokens live in the browser (`localStorage`); publish/API routes receive them only in request headers from this origin.
4. **Instagram requirements** — Test on **Instagram Business/Creator** accounts linked to a **Facebook Page**; personal Instagram accounts cannot use the Content Publishing API.
5. **Rate limits & errors** — Log publish failures (request ids in responses) and surface Meta error messages with actionable hints.

## Google / YouTube Data API v3

1. **OAuth consent screen** — Configure branding, support email, and scopes (`youtube.upload`, `youtube.readonly` as needed).
2. **Verification** — Sensitive scopes may require **Google verification** for public consumer use; keep test users in **Testing** mode during demos.
3. **Quota** — Default daily upload quota applies; monitor in Google Cloud Console.
4. **Upload limits** — This repo uses a **demo max bytes** guard (`NATIVE_GEN_YOUTUBE_MAX_BYTES`) for server-side downloads; increase only when infrastructure supports large uploads.

## Demo hygiene (buildathons)

- Rehearse **Publish to Meta** and **Publish to YouTube** on the venue network.
- Keep a **screen recording** of a successful publish as backup.
- After adding OAuth scopes, ask users to **disconnect and reconnect** once.
