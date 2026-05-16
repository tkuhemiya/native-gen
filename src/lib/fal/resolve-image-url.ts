import { fal } from "@fal-ai/client";

/**
 * fal Florence / remote endpoints need a reachable URL. Upload data URLs to fal storage.
 */
export async function resolveImageUrlForFal(imageUrl: string): Promise<string> {
  const trimmed = imageUrl.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;

  const dataMatch = trimmed.match(/^data:image\/([\w+.-]+);base64,(.+)$/i);
  if (!dataMatch?.[2]) {
    throw new Error("Reference image must be an https URL or a base64 data:image URL");
  }

  const mimeSub = dataMatch[1]!.toLowerCase();
  const mime = `image/${mimeSub}`;
  const buf = Buffer.from(dataMatch[2]!, "base64");
  const ext =
    mimeSub.includes("png") ? "png" : mimeSub.includes("webp") ? "webp" : "jpg";
  const blob = new Blob([buf], { type: mime });
  const file = new File([blob], `workflow-ref.${ext}`, { type: mime });
  return fal.storage.upload(file);
}
