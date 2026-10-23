import type { Block, BriefingDocument, PublishedBriefingDocument } from "@cerebro/briefing-schema";
import type { RetrievedPassage } from "./tasks";
import { terms } from "./text";

/**
 * Project a *published* document into reader-retrievable passages: position,
 * context, request, blocks, perspectives, open questions and approved evidence.
 *
 * The caller must pass the published revision's document (draft-only fields
 * already removed). As a second guard, evidence that is still marked
 * "candidate" or "excluded" is skipped, and `sourceRef` is never read.
 */
export function passagesFromDocument(doc: BriefingDocument | PublishedBriefingDocument, revisionId: string): RetrievedPassage[] {
  const out: RetrievedPassage[] = [];
  const push = (p: Omit<RetrievedPassage, "revisionId">) => {
    if (p.text.trim()) out.push({ ...p, revisionId });
  };

  push({ id: "position", kind: "block", title: "Position", text: `${doc.position.headline}. ${doc.position.summary}` });
  push({
    id: "context",
    kind: "block",
    title: "Why it matters",
    text: [doc.context.stakes, doc.context.background].filter(Boolean).join("\n\n"),
  });
  push({
    id: "request",
    kind: "block",
    title: "Request",
    text: [
      `${capitalise(doc.request.type)} requested: ${doc.request.statement}`,
      doc.request.detail,
      doc.request.dueDate ? `Due ${doc.request.dueDate}.` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  for (const section of doc.sections) {
    for (const block of section.blocks) {
      push({ id: block.id, kind: "block", blockId: block.id, title: section.title, text: blockText(block) });
    }
  }

  for (const p of doc.perspectives) {
    const lines = [p.summary, ...p.implications.map((i) => i.text)].filter(Boolean);
    if (lines.length) push({ id: p.id, kind: "block", title: `Perspective: ${p.label}`, text: lines.join("\n\n") });
  }

  if (doc.openQuestions.length) {
    push({ id: "open_questions", kind: "block", title: "Open questions", text: doc.openQuestions.map((q) => q.text).join("\n\n") });
  }

  for (const ev of doc.evidence) {
    if ("status" in ev && (ev.status === "candidate" || ev.status === "excluded")) continue;
    push({
      id: ev.id,
      kind: "evidence",
      evidenceId: ev.id,
      title: ev.title,
      text: [ev.excerpt, ev.attribution ? `Source: ${ev.attribution}.` : undefined].filter(Boolean).join("\n\n"),
    });
  }
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Reader-visible text for a block, including numbers so they can be cited. */
export function blockText(block: Block): string {
  switch (block.type) {
    case "narrative":
      return block.text;
    case "key_finding":
      return [block.statement, block.detail].filter(Boolean).join("\n\n");
    case "metric": {
      const parts = [`${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ""}${block.asOf ? ` (as of ${block.asOf})` : ""}.`];
      if (block.comparison) parts.push(`${block.comparison.label}: ${block.comparison.value}${block.unit ? ` ${block.unit}` : ""}.`);
      if (block.context) parts.push(block.context);
      return parts.join(" ");
    }
    case "comparison":
      return [
        block.title,
        ...block.rows.map((r) => `${r.label}: ${r.cells.map((c, i) => `${block.columns[i] ?? ""} ${c}`.trim()).join("; ")}.`),
      ]
        .filter(Boolean)
        .join("\n");
    case "chart":
      return [
        `${block.title}.`,
        block.altText,
        ...block.series.map((s) => `${s.label}: ${s.points.map((p) => `${p.x} ${p.y}${block.unit ? ` ${block.unit}` : ""}`).join(", ")}.`),
        block.caption,
      ]
        .filter(Boolean)
        .join("\n");
    case "timeline":
      return [block.title, ...block.items.map((i) => `${i.date ? `${i.date}: ` : ""}${i.label}${i.detail ? `. ${i.detail}` : ""}.`)]
        .filter(Boolean)
        .join("\n");
    case "decision":
      return [
        block.statement,
        ...block.options.map((o) => `${o.chosen ? "Chosen option" : "Option"}: ${o.label}${o.description ? `. ${o.description}` : ""}.`),
        block.rationale,
      ]
        .filter(Boolean)
        .join("\n");
    case "risk":
      return [
        `${capitalise(block.kind)}: ${block.statement}`,
        block.likelihood ? `Likelihood ${block.likelihood}.` : undefined,
        block.impact ? `Impact ${block.impact}.` : undefined,
        block.mitigation ? `Mitigation: ${block.mitigation}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "action":
      return [
        `Action: ${block.statement}`,
        block.owner ? `Owner: ${block.owner}.` : undefined,
        block.dueDate ? `Due ${block.dueDate}.` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
  }
}

export interface RankedPassage {
  passage: RetrievedPassage;
  score: number;
  /** Query terms present in the passage. */
  matched: Set<string>;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  /** Multiplier applied to the passage whose blockId is in focus. */
  focusBlockId?: string;
  focusBoost?: number;
}

/** Inverse document frequency per query term over the passage set (BM25 variant). */
export function idfTable(queryTerms: Iterable<string>, docs: readonly string[][]): Map<string, number> {
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const t of new Set(queryTerms)) {
    const df = docs.reduce((acc, d) => acc + (d.includes(t) ? 1 : 0), 0);
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  return idf;
}

/**
 * BM25-style ranking of already-authorised passages against a question. This
 * ranks; it never widens the passage set. Results are sorted by score
 * descending, ties broken by input order for determinism.
 */
export function rankPassages(question: string, passages: readonly RetrievedPassage[], opts: Bm25Options = {}): RankedPassage[] {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const q = [...new Set(terms(question))];
  const docs = passages.map((p) => terms(`${p.title} ${p.text}`));
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length) || 1;
  const idf = idfTable(q, docs);

  const ranked = passages.map((passage, i) => {
    const doc = docs[i] ?? [];
    const matched = new Set<string>();
    let score = 0;
    for (const t of q) {
      const tf = doc.reduce((acc, d) => acc + (d === t ? 1 : 0), 0);
      if (tf === 0) continue;
      matched.add(t);
      score += (idf.get(t) ?? 0) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgdl)));
    }
    if (opts.focusBlockId && passage.blockId === opts.focusBlockId) score *= opts.focusBoost ?? 1.25;
    return { passage, score, matched, index: i };
  });
  ranked.sort((a, b2) => b2.score - a.score || a.index - b2.index);
  return ranked.map(({ passage, score, matched }) => ({ passage, score, matched }));
}
