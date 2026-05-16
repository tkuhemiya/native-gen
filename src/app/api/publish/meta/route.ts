import { NextResponse } from "next/server";
import { z } from "zod";

import { loadSocialAccountsBlob } from "@/lib/oauth/server-store";
import { humanizeMetaPublishError } from "@/lib/publish/meta-errors";
import {
  publishFacebookPagePhoto,
  publishInstagramCarousel,
  publishInstagramFeedImage,
} from "@/lib/publish/meta-graph";
import { publishLog, resolveRequestId } from "@/lib/publish/log";

const httpsImageUrl = z
  .string()
  .min(1)
  .refine((u) => /^https:\/\//i.test(u), {
    message:
      "Each image must be a public https URL (e.g. from Flux). Local data URLs cannot be posted to Meta APIs.",
  });

const bodySchema = z.object({
  destination: z.enum(["facebook", "instagram"]),
  pageId: z.string().min(1),
  imageUrls: z.array(httpsImageUrl).min(1).max(10),
  caption: z.string().max(2200).optional().default(""),
});

export async function POST(request: Request) {
  const reqId = resolveRequestId(request);
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    publishLog("warn", reqId, "publish_meta_invalid_json");
    return NextResponse.json({ error: "invalid_json", reqId }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const first =
      parsed.error.flatten().fieldErrors.imageUrls?.[0] ??
      parsed.error.flatten().formErrors[0] ??
      "invalid_body";
    publishLog("warn", reqId, "publish_meta_validation", { detail: first });
    return NextResponse.json({ error: first, reqId }, { status: 400 });
  }

  const { destination, pageId, imageUrls, caption } = parsed.data;

  const blob = await loadSocialAccountsBlob();
  if (!blob.meta?.pages.length) {
    publishLog("warn", reqId, "publish_meta_not_connected");
    return NextResponse.json(
      { error: "Connect Facebook / Instagram under Social accounts first.", reqId },
      { status: 401 },
    );
  }

  const page = blob.meta.pages.find((p) => p.id === pageId);
  if (!page) {
    publishLog("warn", reqId, "publish_meta_page_missing", { pageId });
    return NextResponse.json(
      { error: "Selected Page was not found — pick a Page from the list or reconnect.", reqId },
      { status: 400 },
    );
  }

  try {
    if (destination === "facebook") {
      const primary = imageUrls[0];
      if (imageUrls.length > 1) {
        publishLog("info", reqId, "publish_meta_facebook_first_only", { count: imageUrls.length });
      }
      const r = await publishFacebookPagePhoto({
        pageId: page.id,
        pageAccessToken: page.pageAccessToken,
        imageUrl: primary,
        caption,
      });
      publishLog("info", reqId, "publish_meta_facebook_ok", { id: r.id });
      const res = NextResponse.json({
        ok: true,
        destination: "facebook",
        id: r.id,
        permalink: r.permalink ?? null,
        reqId,
      });
      res.headers.set("x-request-id", reqId);
      return res;
    }

    const igUserId = page.instagramUserId;
    if (!igUserId) {
      publishLog("warn", reqId, "publish_meta_no_ig_on_page", { pageId: page.id });
      return NextResponse.json(
        {
          error:
            "This Facebook Page has no linked Instagram Business account. Link one in Meta settings or pick another Page.",
          reqId,
        },
        { status: 400 },
      );
    }

    if (imageUrls.length >= 2) {
      const r = await publishInstagramCarousel({
        igUserId,
        pageAccessToken: page.pageAccessToken,
        imageUrls,
        caption,
      });
      publishLog("info", reqId, "publish_meta_ig_carousel_ok", {
        id: r.id,
        slides: imageUrls.length,
      });
      const res = NextResponse.json({
        ok: true,
        destination: "instagram",
        carousel: true,
        id: r.id,
        permalink: r.permalink ?? null,
        reqId,
      });
      res.headers.set("x-request-id", reqId);
      return res;
    }

    const r = await publishInstagramFeedImage({
      igUserId,
      pageAccessToken: page.pageAccessToken,
      imageUrl: imageUrls[0],
      caption,
    });
    publishLog("info", reqId, "publish_meta_ig_single_ok", { id: r.id });
    const res = NextResponse.json({
      ok: true,
      destination: "instagram",
      carousel: false,
      id: r.id,
      permalink: r.permalink ?? null,
      reqId,
    });
    res.headers.set("x-request-id", reqId);
    return res;
  } catch (e) {
    const raw = e instanceof Error ? e.message : "publish_failed";
    const message = humanizeMetaPublishError(raw);
    publishLog("error", reqId, "publish_meta_failed", { raw });
    const res = NextResponse.json({ error: message, reqId }, { status: 502 });
    res.headers.set("x-request-id", reqId);
    return res;
  }
}
