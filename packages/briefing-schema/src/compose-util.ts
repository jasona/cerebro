import type { IdFactory } from "./ids";
import { newId } from "./ids";

/** Internal helpers shared by the deterministic composers (handoff, markdown). */
export interface ComposeOptions {
  /** Id generator; defaults to `newId`. Pass `sequentialIds()` for reproducible output. */
  ids?: IdFactory;
}

export interface ComposeContext {
  ids: IdFactory;
  gaps: string[];
}

export function createContext(opts?: ComposeOptions): ComposeContext {
  return { ids: opts?.ids ?? newId, gaps: [] };
}

/** Shortens text that exceeds a schema limit and records a gap. Never pads or invents. */
export function clamp(ctx: ComposeContext, text: string, max: number, what: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  ctx.gaps.push(`${what} was longer than ${max} characters and was shortened; review the wording.`);
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function addGap(ctx: ComposeContext, gap: string) {
  if (!ctx.gaps.includes(gap)) ctx.gaps.push(gap);
}

export const NO_EVIDENCE_GAP =
  "No evidence excerpts were supplied; unless evidence is added and approved, the brief will publish with no supporting evidence attached.";
