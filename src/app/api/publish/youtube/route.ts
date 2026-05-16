import { NextResponse } from "next/server";
import { z } from "zod";

import { loadSocialAccountsBlob } from "@/lib/oauth/server-store";
import { publishLog, resolveRequestId } from "@/lib/publish/log";
import { uploadYoutubeVideoFromUrl } from "@/lib/publish/youtube-upload";

const bodySchema = z.object({
  videoUrl: z
    .string()
    .min(1)
    .refine((u) => /^https:\/\//i.test(u), {
      message: "videoUrl must be a public https URL (remote file, not a browser data URL).",
    }),
  title: z.string().min(1).max(100),
  description: z.string().max(5000).optional().default(""),
  privacyStatus: z.enum(["private", "unlisted", "public"]).optional().default("unlisted"),
});

export async function POST(request: Request) {
  const reqId = resolveRequestId(request);
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    publishLog("warn", reqId, "publish_youtube_invalid_json");
    return NextResponse.json({ error: "invalid_json", reqId }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const err = parsed.error.flatten().fieldErrors.videoUrl?.[0] ?? "invalid_body";
    publishLog("warn", reqId, "publish_youtube_validation", { err });
    return NextResponse.json({ error: err, reqId }, { status: 400 });
  }

  const { videoUrl, title, description, privacyStatus } = parsed.data;

  const blob = await loadSocialAccountsBlob();
  if (!blob.google?.refreshToken) {
    publishLog("warn", reqId, "publish_youtube_not_connected");
    return NextResponse.json(
      { error: "Connect YouTube under Social accounts first.", reqId },
      { status: 401 },
    );
  }

  try {
    const { videoId } = await uploadYoutubeVideoFromUrl({
      refreshToken: blob.google.refreshToken,
      videoUrl,
      title,
      description,
      privacyStatus,
    });
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    publishLog("info", reqId, "publish_youtube_ok", { videoId });
    const res = NextResponse.json({
      ok: true,
      videoId,
      watchUrl,
      reqId,
    });
    res.headers.set("x-request-id", reqId);
    return res;
  } catch (e) {
    const raw = e instanceof Error ? e.message : "upload_failed";
    publishLog("error", reqId, "publish_youtube_failed", { raw });
    const res = NextResponse.json({ error: raw, reqId }, { status: 502 });
    res.headers.set("x-request-id", reqId);
    return res;
  }
}
