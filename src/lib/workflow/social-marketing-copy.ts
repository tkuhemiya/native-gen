import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

function fallbackMarketingCopy(opts: {
  campaignBrief: string;
  productDescription?: string;
}): string {
  const brief = opts.campaignBrief.trim().slice(0, 1200);
  const prod = opts.productDescription?.trim().slice(0, 800);
  const lines = [
    brief || "Discover quality you can feel good about.",
    "",
    prod ? `Spotlight: ${prod}` : "",
    "",
    "Hashtags: #brand #organic #quality #lifestyle #wellness #shoplocal",
  ];
  return lines.filter(Boolean).join("\n").trim();
}

/**
 * Social promo body + hashtags for static-image / campaign briefs when `OPENAI_API_KEY` is set.
 * Callers use `POST /api/workflow/social-copy`; story workflows use `outputBlock` instead of legacy platform export nodes.
 */
export async function generateMarketingSocialCopy(opts: {
  campaignBrief: string;
  productDescription?: string;
  sceneBrief?: string;
}): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return fallbackMarketingCopy(opts);
  }

  const openai = createOpenAI({ apiKey: key });
  const modelId =
    process.env.OPENAI_SOCIAL_COPY_MODEL?.trim() ||
    process.env.OPENAI_WORKFLOW_MODEL?.trim() ||
    "gpt-4o-mini";

  const { text } = await generateText({
    model: openai(modelId),
    prompt: `Write social media marketing copy for a static image ad (poster-style creative).

Campaign / creative brief:
${opts.campaignBrief.trim() || "(none)"}

Accurate product reference (from the user's reference image analysis — stay truthful):
${opts.productDescription?.trim() || "(not provided)"}

Visual scene direction for the generated poster:
${opts.sceneBrief?.trim() || "(see brief)"}

Requirements:
- Primary post text: 2–4 short sentences; energetic, brand-safe, specific to the product.
- Include a clear call-to-action line.
- Then a blank line, then a line starting exactly with "Hashtags:" followed by 8–14 relevant hashtags with # symbols, space-separated.
- Do not invent certifications or claims not supported by the brief/reference.`,
  });

  const trimmed = text.trim();
  return trimmed || fallbackMarketingCopy(opts);
}
