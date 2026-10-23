import {
  BriefingDocument,
  GAP_PREFIX,
  handoffToDocument,
  isGapPlaceholder,
  markdownToDocument,
  parseHandoff,
  type EvidenceItem,
} from "@cerebro/briefing-schema";
import { collectIds, seededIds, type IdFactory } from "../ids";
import type { ComposeInput, ComposeOutput, Gap, SourceRef } from "../tasks";

/**
 * Structure-preserving composition. Delegates to the briefing-schema
 * composers (`handoffToDocument`, `markdownToDocument`), which map supplied
 * content onto the schema with visible "Not yet stated" placeholders and never
 * invent content. This adds selected sources as unapproved evidence
 * candidates, applies the stated desired outcome, and reports typed gaps.
 */

const MAX_SHORT = 500;
const MAX_EXCERPT = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_EVIDENCE = /^No evidence excerpts were supplied/;

export interface ComposeDeterministicOptions {
  ids?: IdFactory;
}

function gapKind(message: string): Gap["kind"] {
  if (/position|headline/i.test(message)) return "missing_position";
  if (/why this matters|stakes/i.test(message)) return "missing_stakes";
  if (/\brequest\b|asked to/i.test(message)) return "missing_request";
  if (/attribution/i.test(message)) return "unverified_attribution";
  if (/perspective/i.test(message)) return "empty_perspective";
  if (/evidence/i.test(message)) return "missing_evidence";
  return "other";
}

function clamp(text: string, max: number, what: string, gaps: Gap[]): string {
  const t = text.trim();
  if (t.length <= max) return t;
  gaps.push({ kind: "other", message: `${what} was longer than ${max} characters and was shortened; review the wording.` });
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function requestType(text: string): "decision" | "approval" | "input" | "awareness" {
  const t = text.toLowerCase();
  if (/\bapprov/.test(t)) return "approval";
  if (/\bdecid|\bdecision\b|\bchoose\b/.test(t)) return "decision";
  if (/\binput\b|\bfeedback\b|\bcomment|\breview\b/.test(t)) return "input";
  return "awareness";
}

export function composeDeterministic(input: ComposeInput, opts: ComposeDeterministicOptions = {}): ComposeOutput {
  const ids =
    opts.ids ??
    seededIds(
      JSON.stringify([input.handoffText ?? "", input.handoff ?? null, input.sources.map((s) => s.id), input.desiredOutcome ?? ""]),
      collectIds(input.existingDocument),
    );
  const gaps: Gap[] = [];
  const sourceRefs: SourceRef[] = [];
  const addStringGaps = (messages: readonly string[]) => {
    for (const m of messages) gaps.push({ kind: gapKind(m), message: m.slice(0, 1000) });
  };

  let document: BriefingDocument;
  let notes: string;

  const structured = input.structuredDraft === undefined ? undefined : BriefingDocument.safeParse(input.structuredDraft);
  const handoff = input.handoff === undefined ? undefined : parseHandoff(input.handoff);
  if (structured && !structured.success) {
    gaps.push({ kind: "other", message: "The supplied structured draft did not match the briefing schema and was not used." });
  }
  if (handoff && !handoff.ok) {
    gaps.push({ kind: "other", message: `The handoff package was invalid (${handoff.issues.length} issue(s)) and was not used.` });
  }

  if (structured?.success) {
    // A schema-valid draft already expresses the author's intent: keep it.
    document = structured.data;
    notes = "The supplied structured draft was valid and was kept as written.";
  } else if (handoff?.ok) {
    const composed = handoffToDocument(handoff.handoff, { ids });
    document = composed.document;
    addStringGaps(composed.gaps);
    notes = "Mapped the handoff package onto the briefing structure without rewriting it.";
  } else if (input.handoffText?.trim()) {
    const composed = markdownToDocument(input.handoffText, {
      ids,
      ...(input.existingDocument ? { title: input.existingDocument.title } : {}),
    });
    document = composed.document;
    addStringGaps(composed.gaps);
    notes = "Mapped the selected content onto the briefing structure without rewriting it.";
  } else if (input.existingDocument) {
    document = structuredClone(input.existingDocument);
    notes = "No new thinking was supplied; the existing draft is unchanged apart from any added evidence candidates.";
  } else {
    const composed = markdownToDocument("", { ids });
    document = composed.document;
    addStringGaps(composed.gaps);
    notes = "No content was supplied, so the proposal is an empty scaffold for the author to complete.";
  }

  // The author's stated desired outcome is their request, if none was given.
  if (input.desiredOutcome?.trim() && isGapPlaceholder(document.request.statement)) {
    document.request = {
      ...document.request,
      type: requestType(input.desiredOutcome),
      statement: clamp(input.desiredOutcome, MAX_SHORT, "The desired outcome", gaps),
    };
    for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i]!.kind === "missing_request") gaps.splice(i, 1);
  }

  // Each selected source becomes an unapproved evidence candidate.
  for (const source of input.sources) {
    if (document.evidence.length >= 200) {
      gaps.push({ kind: "other", message: "The evidence limit was reached; some selected sources were not added as candidates." });
      break;
    }
    const id = ids("ev");
    const item: EvidenceItem = {
      id,
      title: clamp(source.title, MAX_SHORT, "A source title", gaps),
      excerpt: clamp(source.text, MAX_EXCERPT, `The excerpt from "${source.title.slice(0, 80)}"`, gaps),
      ...(source.attribution ? { attribution: source.attribution } : {}),
      origin: source.origin,
      status: "candidate",
      ...(UUID.test(source.id) ? { sourceRef: { sourceId: source.id } } : {}),
    };
    document.evidence.push(item);
    sourceRefs.push({ sourceId: source.id, target: "evidence", evidenceId: id });
    if (source.origin === "llm_handoff") {
      gaps.push({
        kind: "unverified_attribution",
        message: `"${source.title.slice(0, 120)}" was supplied by the connected LLM; its attribution is not independently verified.`,
      });
    }
  }
  if (input.sources.length) {
    for (let i = gaps.length - 1; i >= 0; i--) if (NO_EVIDENCE.test(gaps[i]!.message)) gaps.splice(i, 1);
    gaps.push({
      kind: "missing_evidence",
      message: `${input.sources.length} selected source(s) were added as evidence candidates; each must be approved before readers can see it.`,
    });
  }

  addStructuralGaps(document, gaps);
  return { document: BriefingDocument.parse(document), gaps: dedupe(gaps), sourceRefs, notes };
}

function addStructuralGaps(doc: BriefingDocument, gaps: Gap[]): void {
  if (!doc.evidence.some((e) => e.status !== "excluded")) {
    gaps.push({
      kind: "missing_evidence",
      message: "No evidence excerpts were supplied; unless evidence is added and approved, the brief will publish with no supporting evidence attached.",
    });
  }
  doc.sections.forEach((section, si) => {
    section.blocks.forEach((block, bi) => {
      if ((block.type === "key_finding" || block.type === "metric" || block.type === "chart") && block.evidenceRefs.length === 0) {
        gaps.push({
          kind: "unsupported_claim",
          message: `A ${block.type.replace("_", " ")} in "${section.title.slice(0, 80)}" has no linked evidence.`,
          path: `sections.${si}.blocks.${bi}`,
          blockId: block.id,
        });
      }
    });
  });
  doc.perspectives.forEach((p, i) => {
    if (!p.summary.trim() || p.summary.startsWith(GAP_PREFIX)) {
      gaps.push({ kind: "empty_perspective", message: `Perspective "${p.label}" has no summary yet.`, path: `perspectives.${i}.summary` });
    }
  });
}

function dedupe(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  return gaps
    .filter((g) => {
      const key = `${g.path ?? ""}|${g.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
}
