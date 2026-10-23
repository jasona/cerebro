import { blockText, passagesFromDocument } from "@cerebro/ai";
import { PublishedBriefingDocument } from "@cerebro/briefing-schema";
import { briefingRevisions, engagementInsights, publications, type Executor } from "@cerebro/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { canReadRevision, resolveBriefingAccess, type BriefingAccess } from "../access/index";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { ENGAGEMENT_SETTINGS, SUPPRESSED_TOPIC } from "./settings";

export interface ResolvedRevision {
  access: BriefingAccess;
  revisionId: string;
  revisionNumber: number;
  isCurrent: boolean;
  document: PublishedBriefingDocument;
}

/**
 * Resolve the exact revision a reader is asking about. With a number, only
 * that (pinned) revision is used, and only if `canReadRevision` allows it;
 * without one, the current non-withdrawn publication. Never substitutes
 * another revision. Unauthorized and missing are both `not_found`.
 */
export async function resolveReadableRevision(
  tx: Executor,
  ctx: RequestContext,
  briefingId: string,
  revisionNumber?: number,
): Promise<ResolvedRevision> {
  const access = await resolveBriefingAccess(tx, ctx, briefingId);
  if (!access) throw new DomainError("not_found", "Briefing not found.");

  let row: { id: string; number: number; documentJson: unknown } | undefined;
  if (revisionNumber !== undefined) {
    [row] = await tx
      .select({ id: briefingRevisions.id, number: briefingRevisions.number, documentJson: briefingRevisions.documentJson })
      .from(briefingRevisions)
      .where(
        and(
          eq(briefingRevisions.organizationId, ctx.organizationId),
          eq(briefingRevisions.briefingId, briefingId),
          eq(briefingRevisions.number, revisionNumber),
        ),
      );
  } else if (access.currentRevisionId) {
    [row] = await tx
      .select({ id: briefingRevisions.id, number: briefingRevisions.number, documentJson: briefingRevisions.documentJson })
      .from(briefingRevisions)
      .where(and(eq(briefingRevisions.organizationId, ctx.organizationId), eq(briefingRevisions.id, access.currentRevisionId)));
  }
  if (!row || !(await canReadRevision(tx, ctx, briefingId, row.id))) throw new DomainError("not_found", "Briefing not found.");
  // Withdrawal removes reader availability for everyone, collaborators
  // included (canReadRevision lets collaborators see withdrawn history).
  const [live] = await tx
    .select({ id: publications.id })
    .from(publications)
    .where(
      and(
        eq(publications.organizationId, ctx.organizationId),
        eq(publications.revisionId, row.id),
        isNull(publications.withdrawnAt),
      ),
    );
  if (!live) throw new DomainError("not_found", "Briefing not found.");

  const doc = PublishedBriefingDocument.safeParse(row.documentJson);
  if (!doc.success) throw new DomainError("unavailable", "This revision cannot be read right now.");
  return {
    access,
    revisionId: row.id,
    revisionNumber: row.number,
    isCurrent: row.id === access.currentRevisionId,
    document: doc.data,
  };
}

export interface DocumentTargets {
  /** Passage/block keys usable as `blockId` (blocks, position, context, request, perspectives, open_questions). */
  passages: Map<string, { title: string; text: string; sectionId: string | null }>;
  sections: Map<string, string>;
  evidence: Set<string>;
  perspectives: Map<string, string>;
}

/** Index of the reader-visible targets in a published document. */
export function documentTargets(doc: PublishedBriefingDocument, revisionId: string): DocumentTargets {
  const passages = new Map<string, { title: string; text: string; sectionId: string | null }>();
  const sectionOf = new Map<string, string>();
  const sections = new Map<string, string>();
  for (const s of doc.sections) {
    sections.set(s.id, s.title);
    for (const b of s.blocks) sectionOf.set(b.id, s.id);
  }
  for (const p of passagesFromDocument({ ...doc, evidence: [] }, revisionId)) {
    passages.set(p.id, { title: p.title, text: p.text, sectionId: sectionOf.get(p.id) ?? null });
  }
  // Blocks with empty reader text are still valid feedback targets.
  for (const s of doc.sections) {
    for (const b of s.blocks) if (!passages.has(b.id)) passages.set(b.id, { title: s.title, text: blockText(b), sectionId: s.id });
  }
  return {
    passages,
    sections,
    evidence: new Set(doc.evidence.map((e) => e.id)),
    perspectives: new Map(doc.perspectives.map((p) => [p.id, p.label])),
  };
}

export interface TopicInsightDto {
  revisionId: string | null;
  topic: string;
  questionCount: number;
  readerCount: number;
  generatedAt: string;
  /** Always "generated_topic_summary": an automated grouping, not a reader statement. */
  label: "generated_topic_summary";
}

export interface InsightsView {
  topics: TopicInsightDto[];
  /**
   * Questions withheld from topics (small cohorts), summed over the revisions
   * whose withheld questions themselves come from at least `minCohort`
   * distinct readers (D07, W3.6). Null when no revision qualifies: a bare
   * count of one or two readers' questions would disclose their private
   * activity, so "nothing withheld" and "a small cohort withheld" look the same.
   */
  suppressedQuestionCount: number | null;
  /** True when `suppressedQuestionCount` is null. */
  suppressedQuestionCountSuppressed: boolean;
}

/**
 * Latest topic-summary batch per revision for a briefing. Rows below the
 * cohort threshold are dropped again here. Supporting references (question
 * ids) stay in the database and are never returned to authors.
 *
 * The withheld-question count is itself cohort-suppressed: per revision, the
 * reserved `__suppressed__` row carries the number of distinct readers behind
 * the withheld questions, and a revision contributes to the total only when
 * that (lower-bound) reader count meets the threshold. Rows written before
 * readers were recorded there have reader_count 0 and never contribute.
 */
export async function loadLatestInsights(tx: Executor, organizationId: string, briefingId: string): Promise<InsightsView> {
  const rows = await tx
    .select({
      revisionId: engagementInsights.revisionId,
      topic: engagementInsights.topic,
      readerCount: engagementInsights.readerCount,
      questionCount: engagementInsights.questionCount,
      watermark: engagementInsights.watermark,
    })
    .from(engagementInsights)
    .where(
      and(
        eq(engagementInsights.organizationId, organizationId),
        eq(engagementInsights.briefingId, briefingId),
        sql`${engagementInsights.watermark} = (
          select max(j.watermark) from engagement_insights j
          where j.organization_id = ${engagementInsights.organizationId}
            and j.briefing_id = ${engagementInsights.briefingId}
            and j.revision_id is not distinct from ${engagementInsights.revisionId})`,
      ),
    )
    .orderBy(sql`${engagementInsights.questionCount} desc`, engagementInsights.topic);
  const min = ENGAGEMENT_SETTINGS.minCohort;
  // Per revision: withheld questions and a lower bound on their distinct readers.
  const withheld = new Map<string | null, { questions: number; readers: number }>();
  const topics: TopicInsightDto[] = [];
  for (const r of rows) {
    if (r.topic === SUPPRESSED_TOPIC || r.readerCount < min) {
      const w = withheld.get(r.revisionId) ?? { questions: 0, readers: 0 };
      w.questions += r.questionCount;
      // Readers of different rows may overlap, so only the largest single count is a safe lower bound.
      w.readers = Math.max(w.readers, r.readerCount);
      withheld.set(r.revisionId, w);
      continue;
    }
    topics.push({
      revisionId: r.revisionId,
      topic: r.topic,
      questionCount: r.questionCount,
      readerCount: r.readerCount,
      generatedAt: r.watermark.toISOString(),
      label: "generated_topic_summary",
    });
  }
  let disclosed: number | null = null;
  for (const w of withheld.values()) {
    if (w.questions > 0 && w.readers >= min) disclosed = (disclosed ?? 0) + w.questions;
  }
  return { topics, suppressedQuestionCount: disclosed, suppressedQuestionCountSuppressed: disclosed === null };
}
