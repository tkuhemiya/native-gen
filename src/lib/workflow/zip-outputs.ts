import JSZip from "jszip";

import type { RuntimeOutputs } from "@/lib/workflow/runner";

/** Build a downloadable ZIP of images, bundle files, and copy from a run. */
export async function zipRuntimeOutputs(
  outputs: RuntimeOutputs,
  baseName: string,
): Promise<Blob> {
  const zip = new JSZip();
  const safe = baseName.replace(/\s+/g, "-").toLowerCase() || "workflow";

  const addBlob = (path: string, blob: Blob) => {
    zip.file(path, blob);
  };

  for (const [nodeId, out] of Object.entries(outputs)) {
    const prefix = `${safe}/node-${nodeId.slice(0, 8)}`;
    if (out.type === "image") {
      try {
        const res = await fetch(out.url);
        if (res.ok) {
          const ext =
            res.headers.get("content-type")?.includes("png") ? "png" : "jpg";
          addBlob(`${prefix}-generated.${ext}`, await res.blob());
        }
      } catch {
        /* CORS or network — skip */
      }
    } else if (out.type === "generation") {
      if (out.text?.trim()) {
        addBlob(
          `${prefix}-generated-copy.txt`,
          new Blob([out.text], { type: "text/plain;charset=utf-8" }),
        );
      }
      if (out.imageUrl) {
        try {
          const res = await fetch(out.imageUrl);
          if (res.ok) {
            const ext =
              res.headers.get("content-type")?.includes("png") ? "png" : "jpg";
            addBlob(`${prefix}-generated.${ext}`, await res.blob());
          }
        } catch {
          /* skip */
        }
      }
    } else if (out.type === "video") {
      try {
        const res = await fetch(out.url);
        if (res.ok) {
          const ext = res.headers.get("content-type")?.includes("webm") ? "webm" : "mp4";
          addBlob(`${prefix}-generated-video.${ext}`, await res.blob());
        }
      } catch {
        /* skip */
      }
    } else if (out.type === "mediaInput") {
      if (out.text.trim()) {
        addBlob(
          `${prefix}-input-copy.txt`,
          new Blob([out.text], { type: "text/plain;charset=utf-8" }),
        );
      }
      let i = 0;
      for (const u of out.imageUrls) {
        try {
          const r = await fetch(u);
          if (r.ok) {
            addBlob(`${prefix}-input-image-${i}.bin`, await r.blob());
          }
        } catch {
          /* skip */
        }
        i++;
      }
    } else if (out.type === "bundle") {
      for (const f of out.files) {
        const cleanPath = f.path.replace(/^\/+/, "");
        addBlob(`${safe}/${cleanPath}`, f.blob);
      }
    }
  }

  zip.file(
    `${safe}/manifest.json`,
    new Blob(
      [
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            nodeCount: Object.keys(outputs).length,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );

  return zip.generateAsync({ type: "blob" });
}
