/** YouTube Data API resumable upload (demo: small public https videos only). */

const DEMO_MAX_BYTES = Number(process.env.NATIVE_GEN_YOUTUBE_MAX_BYTES ?? 32 * 1024 * 1024);

export type YoutubeUploadInput = {
  refreshToken: string;
  videoUrl: string;
  title: string;
  description: string;
  /** e.g. "22" = People & Blogs */
  categoryId?: string;
  privacyStatus?: "private" | "unlisted" | "public";
};

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token) {
    throw new Error(
      json.error_description ??
        json.error ??
        "Could not refresh Google access token — reconnect YouTube.",
    );
  }
  return json.access_token;
}

export async function uploadYoutubeVideoFromUrl(input: YoutubeUploadInput): Promise<{
  videoId: string;
}> {
  if (!/^https:\/\//i.test(input.videoUrl)) {
    throw new Error("YouTube upload requires a public https video URL.");
  }

  const access = await refreshAccessToken(input.refreshToken);

  const head = await fetch(input.videoUrl, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(`Could not read video URL (HTTP ${head.status}).`);
  }
  const lenHeader = head.headers.get("content-length");
  const len = lenHeader ? Number(lenHeader) : NaN;
  if (Number.isFinite(len) && len > DEMO_MAX_BYTES) {
    throw new Error(
      `Video is larger than the demo limit (${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB). Shrink the file or raise NATIVE_GEN_YOUTUBE_MAX_BYTES for self-hosted.`,
    );
  }

  const videoGet = await fetch(input.videoUrl);
  if (!videoGet.ok) {
    throw new Error(`Failed to download video for upload (HTTP ${videoGet.status}).`);
  }
  const contentType = videoGet.headers.get("content-type") ?? "video/mp4";
  let buffer: ArrayBuffer;
  if (Number.isFinite(len) && len >= 0) {
    if (len > DEMO_MAX_BYTES) {
      throw new Error(
        `Video exceeds demo size limit (${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB).`,
      );
    }
    buffer = await videoGet.arrayBuffer();
  } else {
    const reader = videoGet.body?.getReader();
    if (!reader) {
      buffer = await videoGet.arrayBuffer();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > DEMO_MAX_BYTES) {
            throw new Error(
              `Video exceeds demo size limit (${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB) while streaming.`,
            );
          }
          chunks.push(value);
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      buffer = merged.buffer;
    }
  }

  if (buffer.byteLength > DEMO_MAX_BYTES) {
    throw new Error(
      `Video exceeds demo size limit (${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB).`,
    );
  }

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(buffer.byteLength),
        "X-Upload-Content-Type": contentType,
      },
      body: JSON.stringify({
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description.slice(0, 5000),
          categoryId: input.categoryId ?? "22",
        },
        status: {
          privacyStatus: input.privacyStatus ?? "unlisted",
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    const msg =
      typeof (err as { error?: { message?: string } }).error?.message === "string"
        ? (err as { error: { message: string } }).error.message
        : `YouTube init failed (${initRes.status})`;
    throw new Error(msg);
  }

  const location = initRes.headers.get("Location");
  if (!location) {
    throw new Error("YouTube did not return an upload URL.");
  }

  const putRes = await fetch(location, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
    },
    body: buffer,
  });

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    const msg =
      typeof (err as { error?: { message?: string } }).error?.message === "string"
        ? (err as { error: { message: string } }).error.message
        : `YouTube upload failed (${putRes.status})`;
    throw new Error(msg);
  }

  const uploaded = (await putRes.json()) as { id?: string };
  if (!uploaded.id) {
    throw new Error("YouTube did not return a video id.");
  }

  return { videoId: uploaded.id };
}
