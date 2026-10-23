import { BriefingDocument, Perspective } from "@cerebro/briefing-schema";
import { blockText } from "./retrieval";
import { extractNumbers } from "./text";

/**
 * D06 guard for AI-suggested perspectives. A perspective changes emphasis and
 * implications over the same authorised facts, so a suggestion is accepted
 * for review only when:
 *
 * - it is a schema-valid perspective with something to say;
 * - its label does not duplicate an existing perspective (or another pending suggestion);
 * - `emphasis` names only sections, and implication `blockIds` only blocks, that exist in the draft;
 * - any document id written in its text (`ev_…`, `blk_…`, `sec_…`, `psp_…`, `itm_…`) exists in the draft;
 * - every number in its text already appears in the draft's stated content
 *   (position, context, request, blocks, open questions, existing perspectives
 *   and approved evidence). Candidate and excluded evidence do not count: they
 *   are not facts readers can see.
 *
 * Numbers are a cheap, conservative proxy for "no new facts"; a model can
 * still reword claims, which is why every suggestion also needs explicit
 * author acceptance (principle 2).
 */

export type PerspectiveIssueCode =
  | "invalid_schema"
  | "empty"
  | "duplicate_label"
  | "too_many_perspectives"
  | "unknown_section"
  | "unknown_block"
  | "unknown_reference"
  | "new_number";

export interface PerspectiveIssue {
  code: PerspectiveIssueCode;
  message: string;
}

export type PerspectiveValidation = { ok: true; perspective: Perspective } | { ok: false; issues: PerspectiveIssue[] };

export interface ValidatePerspectiveOptions {
  /** Labels already proposed and still pending, compared case-insensitively. */
  pendingLabels?: readonly string[];
  /** Check the 8-perspective capacity (on acceptance). Default true. */
  checkCapacity?: boolean;
}

const MAX_PERSPECTIVES = 8;
const ID_IN_TEXT = /\b(?:blk|sec|ev|psp|itm)_[A-Za-z0-9_-]{4,64}\b/g;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Every number the draft states to readers (see module comment). */
export function documentFactNumbers(doc: BriefingDocument): Set<string> {
  const parts: string[] = [
    doc.title,
    doc.position.headline,
    doc.position.summary,
    doc.context.stakes,
    doc.context.background ?? "",
    doc.request.statement,
    doc.request.detail ?? "",
    doc.request.dueDate ?? "",
  ];
  for (const s of doc.sections) {
    parts.push(s.title);
    for (const b of s.blocks) parts.push(blockText(b));
  }
  for (const q of doc.openQuestions) parts.push(q.text);
  for (const p of doc.perspectives) parts.push(p.label, p.audience ?? "", p.summary, ...p.implications.map((i) => i.text));
  for (const e of doc.evidence) {
    if ((e.status ?? "candidate") === "approved") parts.push(e.title, e.excerpt, e.attribution ?? "");
  }
  return new Set(extractNumbers(parts.join("\n")));
}

function documentIds(doc: BriefingDocument): Set<string> {
  const ids = new Set<string>();
  for (const s of doc.sections) {
    ids.add(s.id);
    for (const b of s.blocks) ids.add(b.id);
  }
  for (const e of doc.evidence) ids.add(e.id);
  for (const p of doc.perspectives) {
    ids.add(p.id);
    for (const i of p.implications) ids.add(i.id);
  }
  for (const q of doc.openQuestions) ids.add(q.id);
  return ids;
}

export function validateSuggestedPerspective(
  doc: BriefingDocument,
  raw: unknown,
  opts: ValidatePerspectiveOptions = {},
): PerspectiveValidation {
  const parsed = Perspective.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: [{ code: "invalid_schema", message: "The suggestion is not a valid perspective." }] };
  const p = parsed.data;
  const issues: PerspectiveIssue[] = [];

  if (!p.summary.trim() && p.emphasis.length === 0 && p.implications.length === 0) {
    issues.push({ code: "empty", message: "The suggestion has no summary, emphasis or implications." });
  }
  const label = norm(p.label);
  if (doc.perspectives.some((x) => norm(x.label) === label) || (opts.pendingLabels ?? []).some((l) => norm(l) === label)) {
    issues.push({ code: "duplicate_label", message: `A perspective labelled "${p.label}" already exists or is already suggested.` });
  }
  if ((opts.checkCapacity ?? true) && doc.perspectives.length >= MAX_PERSPECTIVES) {
    issues.push({ code: "too_many_perspectives", message: `A briefing holds at most ${MAX_PERSPECTIVES} perspectives.` });
  }

  const sectionIds = new Set(doc.sections.map((s) => s.id));
  const blockIds = new Set(doc.sections.flatMap((s) => s.blocks.map((b) => b.id)));
  const unknownSections = p.emphasis.filter((id) => !sectionIds.has(id));
  if (unknownSections.length) issues.push({ code: "unknown_section", message: `Emphasis names sections that do not exist: ${unknownSections.join(", ")}.` });
  const unknownBlocks = p.implications.flatMap((i) => i.blockIds.filter((id) => !blockIds.has(id)));
  if (unknownBlocks.length) issues.push({ code: "unknown_block", message: `Implications link blocks that do not exist: ${[...new Set(unknownBlocks)].join(", ")}.` });

  const text = [p.label, p.audience ?? "", p.summary, ...p.implications.map((i) => i.text)].join("\n");
  const known = documentIds(doc);
  const unknownRefs = [...new Set([...text.matchAll(ID_IN_TEXT)].map((m) => m[0]))].filter((id) => !known.has(id));
  if (unknownRefs.length) issues.push({ code: "unknown_reference", message: `The text refers to ids that do not exist: ${unknownRefs.join(", ")}.` });

  const facts = documentFactNumbers(doc);
  const newNumbers = [...new Set(extractNumbers(text))].filter((n) => !facts.has(n));
  if (newNumbers.length) issues.push({ code: "new_number", message: `The text states numbers the briefing does not: ${newNumbers.join(", ")}.` });

  if (issues.length) return { ok: false, issues };
  // Normalise: emphasis in reading order, without duplicates.
  const emphasis = doc.sections.map((s) => s.id).filter((id) => p.emphasis.includes(id));
  return { ok: true, perspective: { ...p, emphasis } };
}
