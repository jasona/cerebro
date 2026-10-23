/**
 * Placeholder text used by deterministic composers when a required field was
 * not supplied. Every placeholder starts with `GAP_PREFIX` so it reads as an
 * unresolved gap to authors and `collectIssues` can flag it. Composers never
 * invent content to fill these fields.
 */
export const GAP_PREFIX = "Not yet stated — ";

export const GAP_PLACEHOLDERS = {
  title: "Untitled brief",
  headline: `${GAP_PREFIX}add the position in one line.`,
  summary: `${GAP_PREFIX}add a short summary of the position.`,
  stakes: `${GAP_PREFIX}add why this matters now.`,
  request: `${GAP_PREFIX}add what readers are asked to do.`,
  perspectiveSummary: `${GAP_PREFIX}add what this audience should take from the brief.`,
} as const;

export function isGapPlaceholder(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.startsWith(GAP_PREFIX) || text === GAP_PLACEHOLDERS.title;
}
