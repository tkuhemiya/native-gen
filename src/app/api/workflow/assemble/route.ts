import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Transition = { mode?: string };

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Body must be an object" }, { status: 400 });
  }

  const clips = (body as { clips?: unknown }).clips;
  const transitions = (body as { transitions?: unknown }).transitions;

  if (!Array.isArray(clips) || clips.some((u) => typeof u !== "string" || !u.trim())) {
    return Response.json({ error: "`clips` must be a non-empty string[] of URLs" }, { status: 400 });
  }

  const transArr: Transition[] = Array.isArray(transitions)
    ? (transitions as Transition[])
    : [];

  const gaps = Math.max(0, clips.length - 1);
  for (let g = 0; g < gaps; g += 1) {
    const mode = transArr[g]?.mode ?? "cut";
    if (mode === "bridge") {
      return Response.json(
        {
          code: "bridge_gap_unsupported",
          gapIndex: g,
          error:
            "Bridge transitions need a dedicated frame-to-frame model hook; pick **Cut** in the UI for now.",
        },
        { status: 422 },
      );
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-gen-assemble-"));
  try {
    const segmentRelNames: string[] = [];
    for (let i = 0; i < clips.length; i += 1) {
      const url = clips[i]!;
      const res = await fetch(url);
      if (!res.ok) {
        return Response.json(
          { error: `Failed to download clip ${i + 1} (${res.status})` },
          { status: 502 },
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ext =
        res.headers.get("content-type")?.includes("webm") ? "webm" : "mp4";
      const rel = `seg-${i}.${ext}`;
      await fs.writeFile(path.join(tmp, rel), buf);
      segmentRelNames.push(rel);
    }

    const listPath = path.join(tmp, "list.txt");
    const listBody = segmentRelNames.map((n) => `file '${n}'`).join("\n");
    await fs.writeFile(listPath, listBody, "utf8");

    const outRel = "assembled-out.mp4";
    const outAbs = path.join(tmp, outRel);

    await execFileAsync(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", outAbs],
      { cwd: tmp, maxBuffer: 32 * 1024 * 1024 },
    );

    const file = await fs.readFile(outAbs);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="assembled.mp4"',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      {
        error: `Assembly failed (${msg}). Ensure ffmpeg is installed and on PATH.`,
      },
      { status: 500 },
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
