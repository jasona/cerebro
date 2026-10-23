import type { Block, BlockType, BriefingDocument, PublishedBriefingDocument } from "./document";
import { canonicalJson } from "./publish";

type AnyDocument = BriefingDocument | PublishedBriefingDocument;

export interface SectionRef {
  id: string;
  title: string;
}
export interface BlockRef {
  id: string;
  type: BlockType;
  sectionId: string;
  label: string;
}
export interface BlockChange extends BlockRef {
  /** Top-level block fields that changed, e.g. `["value", "evidenceRefs"]`. */
  fields: string[];
  /** Short human summary, e.g. `Changed metric "Mid-market NRR": value, unit`. */
  summary: string;
}

export interface DocumentDiff {
  /** Changed top-level scalar fields: `title`, `kind`. */
  meta: { field: "title" | "kind"; from: string; to: string }[];
  /** Changed fields within `position`, `context`, `request`. */
  position: string[];
  context: string[];
  request: string[];
  sections: {
    added: (SectionRef & { index: number })[];
    removed: SectionRef[];
    renamed: { id: string; from: string; to: string }[];
    /** Sections whose order changed relative to the others (minimal set, via LCS). */
    moved: (SectionRef & { fromIndex: number; toIndex: number })[];
  };
  blocks: {
    added: BlockRef[];
    removed: BlockRef[];
    changed: BlockChange[];
    /** Moved to another section, or reordered within the same section. */
    moved: (BlockRef & { fromSectionId: string; toSectionId: string })[];
  };
  perspectives: {
    added: { id: string; label: string }[];
    removed: { id: string; label: string }[];
    changed: { id: string; label: string; fields: string[] }[];
  };
  evidence: {
    added: { id: string; title: string }[];
    removed: { id: string; title: string }[];
    /** Same id, different content or approval status. */
    changed: { id: string; title: string; fields: string[] }[];
  };
  openQuestions: {
    added: { id: string; text: string }[];
    removed: { id: string; text: string }[];
    changed: { id: string; text: string }[];
  };
  hasChanges: boolean;
  /** Human-readable change lines, suitable for a change summary. */
  summary: string[];
}

const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  narrative: "narrative",
  key_finding: "key finding",
  metric: "metric",
  comparison: "comparison",
  chart: "chart",
  timeline: "timeline",
  decision: "decision",
  risk: "risk",
  action: "action",
};

function truncate(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short human label for a block (its statement, title, label or first words). */
export function blockLabel(block: Block): string {
  switch (block.type) {
    case "narrative":
      return truncate(block.text);
    case "key_finding":
    case "decision":
    case "action":
      return truncate(block.statement);
    case "risk":
      return truncate(block.statement);
    case "metric":
      return truncate(block.label);
    case "chart":
      return truncate(block.title);
    case "comparison":
    case "timeline":
      return truncate(block.title ?? BLOCK_TYPE_LABEL[block.type]);
  }
}

function describeBlock(block: Block): string {
  const kind = block.type === "risk" ? block.kind : BLOCK_TYPE_LABEL[block.type];
  return `${kind} “${blockLabel(block)}”`;
}

function eq(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function changedFields(a: object, b: object, ignore: string[] = []): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  return [...keys].filter((k) => !ignore.includes(k) && !eq(ra[k], rb[k])).sort();
}

/** Ids in `a` that are part of a longest common subsequence with `b`. */
function lcsIds(a: string[], b: string[]): Set<string> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

interface LocatedBlock {
  block: Block;
  sectionId: string;
}

function indexBlocks(doc: AnyDocument): Map<string, LocatedBlock> {
  const map = new Map<string, LocatedBlock>();
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (!map.has(block.id)) map.set(block.id, { block, sectionId: section.id });
    }
  }
  return map;
}

const quote = (s: string) => `“${truncate(s)}”`;

/**
 * Compares two documents by stable ids, so reordering alone never reads as
 * removal + addition. Works on drafts and published projections.
 */
export function diffDocuments(prev: AnyDocument, next: AnyDocument): DocumentDiff {
  const summary: string[] = [];

  // ── meta & top-level objects ─────────────────────────────────────────────
  const meta: DocumentDiff["meta"] = [];
  if (prev.title !== next.title) {
    meta.push({ field: "title", from: prev.title, to: next.title });
    summary.push(`Retitled the brief to ${quote(next.title)}.`);
  }
  if (prev.kind !== next.kind) {
    meta.push({ field: "kind", from: prev.kind, to: next.kind });
    summary.push(`Changed the brief type from ${prev.kind} to ${next.kind}.`);
  }
  const position = changedFields(prev.position, next.position);
  if (position.length) summary.push(`Updated the position (${position.join(", ")}).`);
  const context = changedFields(prev.context, next.context);
  if (context.length) summary.push(`Updated why it matters now (${context.join(", ")}).`);
  const request = changedFields(prev.request, next.request);
  if (request.length) summary.push(`Updated the request to readers (${request.join(", ")}).`);

  // ── sections ─────────────────────────────────────────────────────────────
  const prevSections = new Map(prev.sections.map((s, i) => [s.id, { s, i }]));
  const nextSections = new Map(next.sections.map((s, i) => [s.id, { s, i }]));
  const sections: DocumentDiff["sections"] = { added: [], removed: [], renamed: [], moved: [] };
  next.sections.forEach((s, i) => {
    if (!prevSections.has(s.id)) {
      sections.added.push({ id: s.id, title: s.title, index: i });
      summary.push(`Added section ${quote(s.title)}.`);
    }
  });
  for (const s of prev.sections) {
    if (!nextSections.has(s.id)) {
      sections.removed.push({ id: s.id, title: s.title });
      summary.push(`Removed section ${quote(s.title)}.`);
    }
  }
  for (const s of next.sections) {
    const before = prevSections.get(s.id);
    if (before && before.s.title !== s.title) {
      sections.renamed.push({ id: s.id, from: before.s.title, to: s.title });
      summary.push(`Renamed section ${quote(before.s.title)} to ${quote(s.title)}.`);
    }
  }
  {
    const commonPrev = prev.sections.map((s) => s.id).filter((id) => nextSections.has(id));
    const commonNext = next.sections.map((s) => s.id).filter((id) => prevSections.has(id));
    const stable = lcsIds(commonPrev, commonNext);
    for (const id of commonNext) {
      if (stable.has(id)) continue;
      const before = prevSections.get(id)!;
      const after = nextSections.get(id)!;
      sections.moved.push({ id, title: after.s.title, fromIndex: before.i, toIndex: after.i });
      summary.push(`Moved section ${quote(after.s.title)}.`);
    }
  }

  // ── blocks ───────────────────────────────────────────────────────────────
  const prevBlocks = indexBlocks(prev);
  const nextBlocks = indexBlocks(next);
  const blocks: DocumentDiff["blocks"] = { added: [], removed: [], changed: [], moved: [] };
  const sectionTitle = (doc: AnyDocument, id: string) => doc.sections.find((s) => s.id === id)?.title ?? id;

  for (const [id, { block, sectionId }] of nextBlocks) {
    const before = prevBlocks.get(id);
    const ref: BlockRef = { id, type: block.type, sectionId, label: blockLabel(block) };
    if (!before) {
      blocks.added.push(ref);
      summary.push(`Added ${describeBlock(block)} in ${quote(sectionTitle(next, sectionId))}.`);
      continue;
    }
    const fields = changedFields(before.block, block, ["id"]);
    if (fields.length) {
      const what = fields.includes("type")
        ? `Changed ${describeBlock(before.block)} into ${describeBlock(block)}`
        : `Changed ${describeBlock(block)}`;
      const line = `${what}: ${fields.join(", ")}`;
      blocks.changed.push({ ...ref, fields, summary: line });
      summary.push(`${line}.`);
    }
    if (before.sectionId !== sectionId) {
      blocks.moved.push({ ...ref, fromSectionId: before.sectionId, toSectionId: sectionId });
      summary.push(
        `Moved ${describeBlock(block)} from ${quote(sectionTitle(prev, before.sectionId))} to ${quote(sectionTitle(next, sectionId))}.`,
      );
    }
  }
  for (const [id, { block, sectionId }] of prevBlocks) {
    if (!nextBlocks.has(id)) {
      blocks.removed.push({ id, type: block.type, sectionId, label: blockLabel(block) });
      summary.push(`Removed ${describeBlock(block)} from ${quote(sectionTitle(prev, sectionId))}.`);
    }
  }
  // Reorders within a section that both versions share.
  for (const section of next.sections) {
    const before = prevSections.get(section.id);
    if (!before) continue;
    const inBoth = (id: string) => prevBlocks.get(id)?.sectionId === section.id && nextBlocks.get(id)?.sectionId === section.id;
    const a = before.s.blocks.map((b) => b.id).filter(inBoth);
    const b = section.blocks.map((blk) => blk.id).filter(inBoth);
    const stable = lcsIds(a, b);
    for (const id of b) {
      if (stable.has(id)) continue;
      const { block } = nextBlocks.get(id)!;
      blocks.moved.push({
        id,
        type: block.type,
        sectionId: section.id,
        label: blockLabel(block),
        fromSectionId: section.id,
        toSectionId: section.id,
      });
      summary.push(`Reordered ${describeBlock(block)} within ${quote(section.title)}.`);
    }
  }

  // ── perspectives ─────────────────────────────────────────────────────────
  const perspectives: DocumentDiff["perspectives"] = { added: [], removed: [], changed: [] };
  const prevP = new Map(prev.perspectives.map((p) => [p.id, p]));
  const nextP = new Map(next.perspectives.map((p) => [p.id, p]));
  for (const p of next.perspectives) {
    const before = prevP.get(p.id);
    if (!before) {
      perspectives.added.push({ id: p.id, label: p.label });
      summary.push(`Added the ${p.label} perspective.`);
      continue;
    }
    const fields = changedFields(before, p, ["id"]);
    if (fields.length) {
      perspectives.changed.push({ id: p.id, label: p.label, fields });
      summary.push(`Updated the ${p.label} perspective (${fields.join(", ")}).`);
    }
  }
  for (const p of prev.perspectives) {
    if (!nextP.has(p.id)) {
      perspectives.removed.push({ id: p.id, label: p.label });
      summary.push(`Removed the ${p.label} perspective.`);
    }
  }

  // ── evidence ─────────────────────────────────────────────────────────────
  const evidence: DocumentDiff["evidence"] = { added: [], removed: [], changed: [] };
  const prevE = new Map(prev.evidence.map((e) => [e.id, e]));
  const nextE = new Map(next.evidence.map((e) => [e.id, e]));
  for (const e of next.evidence) {
    const before = prevE.get(e.id);
    if (!before) {
      evidence.added.push({ id: e.id, title: e.title });
      summary.push(`Added evidence ${quote(e.title)}.`);
      continue;
    }
    const fields = changedFields(before, e, ["id"]);
    if (fields.length) {
      evidence.changed.push({ id: e.id, title: e.title, fields });
      summary.push(`Updated evidence ${quote(e.title)} (${fields.join(", ")}).`);
    }
  }
  for (const e of prev.evidence) {
    if (!nextE.has(e.id)) {
      evidence.removed.push({ id: e.id, title: e.title });
      summary.push(`Removed evidence ${quote(e.title)}.`);
    }
  }

  // ── open questions ───────────────────────────────────────────────────────
  const openQuestions: DocumentDiff["openQuestions"] = { added: [], removed: [], changed: [] };
  const prevQ = new Map(prev.openQuestions.map((q) => [q.id, q]));
  const nextQ = new Map(next.openQuestions.map((q) => [q.id, q]));
  for (const q of next.openQuestions) {
    const before = prevQ.get(q.id);
    if (!before) {
      openQuestions.added.push({ id: q.id, text: q.text });
      summary.push(`Added open question ${quote(q.text)}.`);
    } else if (before.text !== q.text) {
      openQuestions.changed.push({ id: q.id, text: q.text });
      summary.push(`Reworded open question ${quote(q.text)}.`);
    }
  }
  for (const q of prev.openQuestions) {
    if (!nextQ.has(q.id)) {
      openQuestions.removed.push({ id: q.id, text: q.text });
      summary.push(`Removed open question ${quote(q.text)}.`);
    }
  }

  return {
    meta,
    position,
    context,
    request,
    sections,
    blocks,
    perspectives,
    evidence,
    openQuestions,
    hasChanges: summary.length > 0,
    summary,
  };
}
