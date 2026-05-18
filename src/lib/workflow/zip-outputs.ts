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
    } else if (out.type === "text") {
      if (out.value.trim()) {
        addBlob(
          `${prefix}-text.txt`,
          new Blob([out.value], { type: "text/plain;charset=utf-8" }),
        );
      }
    } else if (out.type === "sceneContext") {
      if (out.script.trim()) {
        addBlob(
          `${prefix}-scene-script.txt`,
          new Blob([out.script], { type: "text/plain;charset=utf-8" }),
        );
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
