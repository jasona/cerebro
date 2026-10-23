import type { AnswerOutput, AnswerPart, RetrievedPassage } from "./tasks";
import { extractNumbers, looksLikeInstruction, terms } from "./text";

/**
 * Deterministic post-validation applied to every provider's answer output.
 *
 * 1. `validateCitations` confirms each cited id resolves to a supplied passage.
 *    The supplied passages are already scoped to the authorised revision.
 * 2. `checkSupport` confirms, heuristically, that cited material supports the
 *    part: numbers must appear in the cited passages and "stated" parts need
 *    lexical overlap with them. Valid ids alone do not prove support.
 *
 * Both return a new output; the input is never mutated.
 */

export type AnswerWarningCode =
  | "invalid_citation"
  | "uncited_part"
  | "unsupported_number"
  | "instruction_like_content"
  | "relabelled_inferred"
  | "dropped_low_overlap"
  | "no_stated_support"
  | "downgraded_to_insufficient"
  | "foreign_revision_passage";

export interface AnswerWarning {
  code: AnswerWarningCode;
  /** Index of the part in the output being checked, when applicable. */
  partIndex?: number;
  /** Ids or values only; never passage text. */
  detail?: string;
}

export interface ValidationResult {
  output: AnswerOutput;
  warnings: AnswerWarning[];
}

export interface SupportOptions {
  /** Share of a stated part's terms that must occur in its cited passages. */
  statedOverlap?: number;
  /** Below this share an inferred part has no anchor and is dropped. */
  inferredOverlap?: number;
}

const DEFAULT_STATED_OVERLAP = 0.6;
const DEFAULT_INFERRED_OVERLAP = 0.3;

const NOT_VERIFIED =
  "The answer could not be verified against the published briefing and its approved evidence.";

function rebuildCitations(parts: AnswerPart[]): AnswerOutput["citations"] {
  const seen = new Set<string>();
  const out: AnswerOutput["citations"] = [];
  for (const part of parts) {
    for (const id of part.citations) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ passageId: id });
    }
  }
  return out;
}

function finalise(
  original: AnswerOutput,
  parts: AnswerPart[],
  warnings: AnswerWarning[],
): AnswerOutput {
  let status = original.status;
  let missing = original.missing;
  if (status === "answered" && !parts.some((p) => p.kind === "stated")) {
    status = "insufficient";
    missing = missing ?? NOT_VERIFIED;
    warnings.push({ code: parts.length ? "no_stated_support" : "downgraded_to_insufficient" });
    if (parts.length) warnings.push({ code: "downgraded_to_insufficient" });
  }
  const out: AnswerOutput = { status, answer: parts, citations: rebuildCitations(parts) };
  if (missing !== undefined) out.missing = missing;
  return out;
}

export function validateCitations(output: AnswerOutput, passages: readonly RetrievedPassage[]): ValidationResult {
  const known = new Set(passages.map((p) => p.id));
  const warnings: AnswerWarning[] = [];
  const parts: AnswerPart[] = [];

  output.answer.forEach((part, partIndex) => {
    const invalid = part.citations.filter((id) => !known.has(id));
    if (invalid.length) {
      warnings.push({ code: "invalid_citation", partIndex, detail: invalid.join(",").slice(0, 200) });
      return;
    }
    if (part.citations.length === 0) {
      warnings.push({ code: "uncited_part", partIndex });
      return;
    }
    parts.push({ ...part, citations: [...new Set(part.citations)] });
  });

  for (const c of output.citations) {
    if (!known.has(c.passageId)) warnings.push({ code: "invalid_citation", detail: c.passageId.slice(0, 200) });
  }

  return { output: finalise(output, parts, warnings), warnings };
}

export function checkSupport(
  output: AnswerOutput,
  passages: readonly RetrievedPassage[],
  opts: SupportOptions = {},
): ValidationResult {
  const statedMin = opts.statedOverlap ?? DEFAULT_STATED_OVERLAP;
  const inferredMin = opts.inferredOverlap ?? DEFAULT_INFERRED_OVERLAP;
  const byId = new Map(passages.map((p) => [p.id, p]));
  const warnings: AnswerWarning[] = [];
  const parts: AnswerPart[] = [];

  output.answer.forEach((part, partIndex) => {
    const cited = part.citations.map((id) => byId.get(id)).filter((p): p is RetrievedPassage => p !== undefined);
    if (cited.length === 0) {
      warnings.push({ code: "uncited_part", partIndex });
      return;
    }
    if (looksLikeInstruction(part.text)) {
      warnings.push({ code: "instruction_like_content", partIndex });
      return;
    }

    const citedText = cited.map((p) => `${p.title}\n${p.text}`).join("\n");
    const available = new Set(extractNumbers(citedText));
    const unsupported = extractNumbers(part.text).filter((n) => !available.has(n));
    if (unsupported.length) {
      warnings.push({ code: "unsupported_number", partIndex, detail: [...new Set(unsupported)].join(",").slice(0, 200) });
      return;
    }

    const partTerms = [...new Set(terms(part.text))];
    const citedTerms = new Set(terms(citedText));
    const overlap = partTerms.length ? partTerms.filter((t) => citedTerms.has(t)).length / partTerms.length : 0;

    if (part.kind === "stated") {
      if (overlap >= statedMin) parts.push(part);
      else if (overlap >= inferredMin) {
        warnings.push({ code: "relabelled_inferred", partIndex, detail: overlap.toFixed(2) });
        parts.push({ ...part, kind: "inferred" });
      } else {
        warnings.push({ code: "dropped_low_overlap", partIndex, detail: overlap.toFixed(2) });
      }
      return;
    }
    if (overlap >= inferredMin) parts.push(part);
    else warnings.push({ code: "dropped_low_overlap", partIndex, detail: overlap.toFixed(2) });
  });

  return { output: finalise(output, parts, warnings), warnings };
}

/** Restrict passages to the authorised revision, warning about any others. */
export function scopePassages(
  passages: readonly RetrievedPassage[],
  revisionId: string,
): { passages: RetrievedPassage[]; warnings: AnswerWarning[] } {
  const kept: RetrievedPassage[] = [];
  const warnings: AnswerWarning[] = [];
  for (const p of passages) {
    if (p.revisionId === revisionId) kept.push(p);
    else warnings.push({ code: "foreign_revision_passage", detail: p.id.slice(0, 200) });
  }
  return { passages: kept, warnings };
}

/** Both checks, in order. This is what `runAnswer` applies. */
export function validateAnswer(
  output: AnswerOutput,
  passages: readonly RetrievedPassage[],
  opts: SupportOptions = {},
): ValidationResult {
  const a = validateCitations(output, passages);
  const b = checkSupport(a.output, passages, opts);
  return { output: b.output, warnings: [...a.warnings, ...b.warnings] };
}
