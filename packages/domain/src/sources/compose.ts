/**
 * Compose a draft from an extracted private source (PDF, DOCX, PPTX, text).
 *
 * Deterministic and model-free: the extracted chunks are arranged as
 * Markdown (one `##` section per page/slide/locator group, slide titles as
 * headings when recognisable) and passed through `markdownToDocument`, which
 * never invents content and reports missing position/stakes/request as gaps.
 * Every chunk becomes a *candidate* EvidenceItem with `sourceRef` and
 * locator attribution; nothing is approved, so nothing from the source
 * reaches readers without an explicit author approval and publication.
 *
 * Replacing the draft is allowed only when it is still the untouched blank
 * template, or when the author explicitly asks (`replace: true`). The write
 * uses the same compare-and-increment `lock_version` check as every edit.
 */
import {
  BriefingDocument,
  isGapPlaceholder,
  markdownToDocument,
  newId,
  GAP_PLACEHOLDERS,
  type DocumentIssue,
  type EvidenceItem,
} from "@cerebro/briefing-schema";
import { briefingSources, sourceChunks, sources, withAuthContext, type Database } from "@cerebro/database";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import { recordAudit } from "../audit";
import { loadDraftRow, parseStoredDraft, updateDraftInTx } from "../briefings/drafts";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { latestExtractionMeta, SOURCE_KIND_TO_ORIGIN } from "./sources";

export const ComposeDraftFromSourceInput = z
  .object({
    briefingId: z.string().uuid(),
    /** Draft `lock_version` the author is looking at. */
    expectedVersion: z.number().int().positive(),
    sourceId: z.string().uuid(),
    /**
     * Explicit author action to replace a draft that already has content.
     * Without it, only the untouched blank template is replaced.
     */
    replace: z.boolean().optional(),
  })
  .strict();
export type ComposeDraftFromSourceInput = z.input<typeof ComposeDraftFromSourceInput>;

export interface ComposeDraftFromSourceResult {
  briefingId: string;
  draftVersion: number;
  issues: DocumentIssue[];
  /** Composition gaps (missing position, request, shortened text, dropped passages, …). */
  gaps: string[];
  /** Candidate evidence items added from the source's passages. */
  evidenceAdded: number;
  /** Whether a draft with existing content was replaced at the author's request. */
  replaced: boolean;
}

const MAX_SECTIONS = 30;
const MAX_EVIDENCE = 200;
const MAX_REFS_PER_BLOCK = 20;
const MAX_EXCERPT = 5000;
const SLIDE_TITLE_MAX = 120;

/**
 * True when the draft is still the blank template a new brief starts from:
 * every required field is a gap placeholder, blocks hold only placeholder or
 * empty narrative text, and there is no evidence, perspective or question.
 * The title is ignored (new briefs are named after the uploaded file).
 */
export function isUntouchedTemplate(doc: BriefingDocument): boolean {
  if (doc.evidence.length || doc.perspectives.length || doc.openQuestions.length) return false;
  if (!isGapPlaceholder(doc.position.headline) || !isGapPlaceholder(doc.position.summary)) return false;
  if (!isGapPlaceholder(doc.context.stakes) || doc.context.background) return false;
  if (!isGapPlaceholder(doc.request.statement) || doc.request.detail || doc.request.dueDate) return false;
  if (doc.sections.length > 1) return false;
  return doc.sections.every((s) =>
    s.blocks.every((b) => b.type === "narrative" && (b.text.trim() === "" || isGapPlaceholder(b.text)) && b.evidenceRefs.length === 0),
  );
}

interface ChunkRow {
  id: string;
  ordinal: number;
  text: string;
  locator: string | null;
}

interface Group {
  heading: string;
  chunks: ChunkRow[];
}

/** "Slide 3 notes" and "Slide 3" belong to the same slide. */
const groupKey = (locator: string | null) => (locator ?? "").replace(/\s+notes$/i, "").trim();

/** Neutralise Markdown structure inside extracted text: headings become bold lines, fences are defused. */
function sanitizeChunkText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const h = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) return h[1] ? `**${h[1]}**` : "";
      return line.replace(/^(\s*)(```|~~~)/, "$1'''");
    })
    .join("\n");
}

/** A slide's first paragraph is its title when it is short and single-line. */
function slideTitle(group: Group): string | null {
  if (!/^slide\s+\d+$/i.test(group.heading)) return null;
  const first = group.chunks[0]?.text.split(/\n\s*\n/)[0]?.trim();
  if (!first || first.includes("\n") || first.length > SLIDE_TITLE_MAX) return null;
  return first;
}

/** Group chunks by locator (page, slide, …), merging consecutive groups so there are at most 30 sections. */
function groupChunks(chunks: ChunkRow[], fallbackHeading: string): Group[] {
  const groups: Group[] = [];
  for (const ch of chunks) {
    const key = groupKey(ch.locator);
    const last = groups[groups.length - 1];
    if (last && groupKey(last.chunks[0]!.locator) === key) last.chunks.push(ch);
    else groups.push({ heading: key || fallbackHeading, chunks: [ch] });
  }
  if (groups.length <= MAX_SECTIONS) return groups;
  const size = Math.ceil(groups.length / MAX_SECTIONS);
  const merged: Group[] = [];
  for (let i = 0; i < groups.length; i += size) {
    const part = groups.slice(i, i + size);
    const first = part[0]!.heading;
    const last = part[part.length - 1]!.heading;
    merged.push({ heading: first === last ? first : `${first} – ${last}`, chunks: part.flatMap((g) => g.chunks) });
  }
  return merged;
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Replace the draft with a deterministic composition of an extracted source.
 * Requires `edit`, a source linked to the briefing whose extraction succeeded
 * (complete or partial), and the current `expectedVersion`.
 *
 * Errors: `not_found` (briefing or linked source), `validation` with
 * `reasons` (`extraction_pending`, `extraction_failed`, `no_extracted_text`),
 * `conflict` with `{ currentVersion }` for a stale version, or with
 * `{ currentVersion, reasons: ["draft_not_blank"] }` when the draft has content
 * and `replace` was not set.
 */
export async function composeDraftFromSource(
  db: Database,
  ctx: RequestContext,
  raw: ComposeDraftFromSourceInput,
): Promise<ComposeDraftFromSourceResult> {
  const c = RequestContext.parse(ctx);
  const parsed = ComposeDraftFromSourceInput.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("validation", "Invalid compose request.", { issues: parsed.error.issues.map((i) => i.message) });
  }
  const input = parsed.data;

  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");

    const [src] = await tx
      .select({
        id: sources.id,
        title: sources.title,
        kind: sources.kind,
        attribution: sources.attribution,
        status: sources.extractionStatus,
      })
      .from(sources)
      .innerJoin(
        briefingSources,
        and(
          eq(briefingSources.organizationId, sources.organizationId),
          eq(briefingSources.sourceId, sources.id),
          eq(briefingSources.briefingId, input.briefingId),
        ),
      )
      .where(and(eq(sources.organizationId, c.organizationId), eq(sources.id, input.sourceId)));
    // Sources not linked to this briefing are indistinguishable from missing ones.
    if (!src) throw new DomainError("not_found", "Source not found.");
    if (src.status === "pending" || src.status === "running") {
      throw new DomainError("validation", "The source is still being extracted.", { reasons: ["extraction_pending"] });
    }
    if (src.status !== "succeeded") {
      throw new DomainError("validation", "The source could not be extracted.", { reasons: ["extraction_failed"] });
    }

    const chunks = await tx
      .select({ id: sourceChunks.id, ordinal: sourceChunks.ordinal, text: sourceChunks.text, locator: sourceChunks.locator })
      .from(sourceChunks)
      .where(and(eq(sourceChunks.organizationId, c.organizationId), eq(sourceChunks.sourceId, src.id)))
      .orderBy(asc(sourceChunks.ordinal));
    if (!chunks.some((ch) => ch.text.trim())) {
      throw new DomainError("validation", "No text was extracted from the source.", { reasons: ["no_extracted_text"] });
    }

    const row = await loadDraftRow(tx, c, input.briefingId, { forUpdate: true });
    if (row.lockVersion !== input.expectedVersion) {
      throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: row.lockVersion });
    }
    const current = parseStoredDraft(row.documentJson);
    const blank = isUntouchedTemplate(current);
    if (!blank && !input.replace) {
      throw new DomainError("conflict", "The draft already has content. Confirm to replace it with a draft from this source.", {
        currentVersion: row.lockVersion,
        reasons: ["draft_not_blank"],
      });
    }

    // Existing evidence from other sources/handoffs is kept (never silently
    // dropped); passages of this source are re-added as fresh candidates.
    const kept = current.evidence.filter((e) => e.sourceRef?.sourceId !== src.id);
    const room = Math.max(0, MAX_EVIDENCE - kept.length);
    const textChunks = chunks.filter((ch) => ch.text.trim());
    const extraGaps: string[] = [];
    if (textChunks.length > room) {
      extraGaps.push(
        `The source has ${textChunks.length} passages; only the first ${room} were added as candidate evidence (a draft holds at most ${MAX_EVIDENCE} evidence items).`,
      );
    }

    const baseTitle = src.title.replace(/\.(pdf|docx|pptx|md|markdown|txt)$/i, "").trim() || "Source";
    const title = isGapPlaceholder(current.title) ? baseTitle : current.title;
    const groups = groupChunks(textChunks, baseTitle);

    // Arrange as Markdown; slide titles become section headings.
    const md: string[] = [`# ${title.replace(/\s+/g, " ")}`, ""];
    for (const g of groups) {
      const st = slideTitle(g);
      md.push(`## ${st ? `${g.heading}: ${st}` : g.heading}`, "");
      g.chunks.forEach((ch, i) => {
        let text = ch.text;
        if (st && i === 0) text = text.split(/\n\s*\n/).slice(1).join("\n\n") || text;
        md.push(sanitizeChunkText(text), "");
      });
    }
    const composed = markdownToDocument(md.join("\n"), { title });
    let doc = composed.document;

    // Evidence: one candidate per passage, linked from its section's first block.
    const evidence: EvidenceItem[] = [];
    const sectionRefs: string[][] = groups.map(() => []);
    groups.forEach((g, gi) => {
      for (const ch of g.chunks) {
        if (evidence.length >= room) return;
        const id = newId("ev");
        const label = ch.locator ? `${baseTitle}, ${ch.locator}` : baseTitle;
        evidence.push({
          id,
          title: shorten(label, 200),
          excerpt: shorten(ch.text.trim(), MAX_EXCERPT),
          ...(src.attribution ? { attribution: shorten(src.attribution, 300) } : {}),
          ...(ch.locator ? { locator: ch.locator.slice(0, 200) } : {}),
          origin: SOURCE_KIND_TO_ORIGIN[src.kind] ?? "manual",
          status: "candidate",
          sourceRef: { sourceId: src.id, chunkId: ch.id },
        });
        sectionRefs[gi]!.push(id);
      }
    });

    doc = {
      ...doc,
      kind: current.kind,
      // The file name is not a position: keep the headline an explicit gap.
      position: { ...doc.position, headline: doc.position.headline === title ? GAP_PLACEHOLDERS.headline : doc.position.headline },
      sections: doc.sections.map((s, si) => {
        const refs = (sectionRefs[si] ?? []).slice(0, MAX_REFS_PER_BLOCK).map((evidenceId) => ({ evidenceId }));
        if (!refs.length || !s.blocks.length) return s;
        const [first, ...rest] = s.blocks;
        return { ...s, blocks: [{ ...first!, evidenceRefs: refs }, ...rest] };
      }),
      evidence: [...kept, ...evidence],
      openQuestions: current.openQuestions,
    };
    doc = BriefingDocument.parse(doc);

    const updated = await updateDraftInTx(tx, c, {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      document: doc,
    });

    const meta = await latestExtractionMeta(tx, c.organizationId, src.id);
    const gaps = [
      ...composed.gaps.filter((g) => !g.startsWith("No evidence excerpts were supplied")),
      ...extraGaps,
      ...(meta.completeness === "partial" ? ["The source was only partially extracted; some content may be missing. Check the extraction gaps."] : []),
      "Passages were added as candidate evidence. Review and approve the ones that support your claims before publishing.",
    ];

    await recordAudit(tx, c, {
      action: "draft.composed_from_source",
      targetType: "briefing",
      targetId: input.briefingId,
      metadata: { sourceId: src.id, evidenceAdded: evidence.length, sections: doc.sections.length, replaced: !blank },
    });

    return {
      briefingId: input.briefingId,
      draftVersion: updated.draftVersion,
      issues: updated.issues,
      gaps,
      evidenceAdded: evidence.length,
      replaced: !blank,
    };
  });
}
