/** UX + layout hint for how a text primitive fits the story stack (see workflow agent system prompt). */
export type StoryNodeRole =
  | "lore"
  | "world"
  | "character"
  | "place"
  | "plot"
  | "scene"
  | "other";

const ROLE_ORDER: StoryNodeRole[] = [
  "lore",
  "world",
  "character",
  "place",
  "plot",
  "scene",
  "other",
];

/** Stable vertical order when stacking “global” (non-scene) text nodes. */
export function storyRoleSortKey(role: StoryNodeRole): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

/**
 * Infer a coarse story layer from label/purpose (best-effort; refine in Purpose tag when ambiguous).
 */
export function inferTextPrimitiveStoryRole(label: string, purpose: string): StoryNodeRole {
  const blob = `${purpose} ${label}`.trim().toLowerCase();
  const lab = label.trim().toLowerCase();

  if (/\b(lore|bible)\b|\bcanon\b|rules of|world rules/i.test(blob)) return "lore";
  if (/\b(world|setting|universe)\b/i.test(blob)) return "world";
  if (/\b(character|cast|protagonist|sheet)\b/i.test(blob)) return "character";
  if (/\b(place|location|venue|registry)\b|establishing shot/i.test(blob)) return "place";
  if (/\b(plot|outline|arc)\b/i.test(blob)) return "plot";
  if (/^\s*scene\s*\d+\b/i.test(lab) || /\bscene\s*\d+\b/i.test(blob)) return "scene";
  /** Single-word anchors (“Beat 2”) when not a plot/outline doc. */
  if (/^\s*beat\s*\d+\b/i.test(lab) || /^\s*shot\s*\d+\b/i.test(lab)) return "scene";

  return "other";
}

/** Optional ordering key inside the “scene” lane (Scene 1 → 1). */
export function inferSceneSortIndex(label: string, purpose: string): number {
  const blob = `${purpose} ${label}`;
  const m = blob.match(/\bscene\s*(\d+)\b/i) ?? blob.match(/\b(?:shot|beat)\s*(\d+)\b/i);
  if (m) return Number.parseInt(m[1]!, 10);
  return Number.POSITIVE_INFINITY;
}
