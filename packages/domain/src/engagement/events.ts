import { createHash, createHmac } from "node:crypto";
import { briefingRevisions, engagementEvents, enqueueJob, publications, withAuthContext, type Database } from "@cerebro/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import { recordAudit } from "../audit";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { dedupeKeys } from "../jobs/kinds";
import { log } from "../ops/log";
import { revisionNumbers } from "./feedback";
import { documentTargets, loadLatestInsights, resolveReadableRevision } from "./revision";
import { ENGAGEMENT_DISCLOSURE, ENGAGEMENT_LABELS, ENGAGEMENT_SETTINGS } from "./settings";

const parseCtx = (ctx: RequestContext) => RequestContext.parse(ctx);
const authOf = (c: RequestContext) => ({ userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId });

/** Events a reader client may record. Questions and feedback are counted from their own tables. */
export const RECORDABLE_EVENT_TYPES = ["open", "section_view", "block_view", "evidence_open", "perspective_select"] as const;
export type RecordableEventType = (typeof RECORDABLE_EVENT_TYPES)[number];

let warnedSecret = false;
function pseudonymSecret(): string {
  const s = process.env.ENGAGEMENT_PSEUDONYM_SECRET ?? process.env.SESSION_SECRET;
  if (s) return s;
  if (!warnedSecret && process.env.NODE_ENV === "production") {
    warnedSecret = true;
    log.warn("config.default_secret", { component: "engagement", detail: "engagement pseudonym secret not configured; using dev default" });
  }
  return "cerebro-dev-engagement-pseudonym";
}

/**
 * Pseudonymous reader key, stable per organization + briefing and keyed by a
 * server secret so it cannot be reversed by enumerating user ids. It is stored
 * in `engagement_events.session_id`; distinct-reader counts use it so that
 * one reader with many sessions is never counted as a cohort.
 */
export function readerPseudonym(organizationId: string, briefingId: string, userId: string): string {
  return createHmac("sha256", pseudonymSecret()).update(`${organizationId}:${briefingId}:${userId}`).digest("hex").slice(0, 32);
}

export const RecordEngagementEventInput = z.object({
  briefingId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  type: z.enum(RECORDABLE_EVENT_TYPES),
  blockId: z.string().min(1).max(100).optional(),
  /** Client session identifier; hashed, never stored as given. */
  sessionKey: z.string().min(8).max(200),
});
export type RecordEngagementEventInput = z.input<typeof RecordEngagementEventInput>;

/**
 * Record a measured reader event with a minimal payload: type, revision,
 * optional block key and a pseudonymous key. Deduplicated per reader session,
 * event type and target. Requires read on the revision.
 */
export async function recordEngagementEvent(
  db: Database,
  ctx: RequestContext,
  raw: RecordEngagementEventInput,
): Promise<{ recorded: boolean }> {
  const c = parseCtx(ctx);
  const parsed = RecordEngagementEventInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid engagement event.");
  const input = parsed.data;
  return withAuthContext(db, authOf(c), async (tx) => {
    const rev = await resolveReadableRevision(tx, c, input.briefingId, input.revisionNumber);
    if (input.blockId) {
      const t = documentTargets(rev.document, rev.revisionId);
      const known =
        t.passages.has(input.blockId) || t.sections.has(input.blockId) || t.evidence.has(input.blockId) || t.perspectives.has(input.blockId);
      if (!known) throw new DomainError("validation", "Unknown block for this revision.");
    }
    const sessionId = readerPseudonym(c.organizationId, input.briefingId, c.userId);
    const dedupeKey = createHash("sha256")
      .update([input.type, rev.revisionId, input.blockId ?? "-", sessionId, input.sessionKey].join("\u0000"))
      .digest("hex");
    const inserted = await tx
      .insert(engagementEvents)
      .values({
        organizationId: c.organizationId,
        briefingId: input.briefingId,
        revisionId: rev.revisionId,
        sessionId,
        eventType: input.type,
        blockKey: input.blockId ?? null,
        dedupeKey,
      })
      .onConflictDoNothing({ target: [engagementEvents.organizationId, engagementEvents.dedupeKey] })
      .returning({ id: engagementEvents.id });
    return { recorded: inserted.length > 0 };
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface CohortCount {
  /** Null when suppressed. */
  value: number | null;
  suppressed: boolean;
}

export interface RevisionEngagementDto {
  revisionNumber: number;
  publishedAt: string | null;
  isCurrent: boolean;
  /**
   * Activity counts are cohort-suppressed: each is null, with its sibling
   * `*Suppressed` flag true, when fewer than `minCohort` distinct readers
   * contributed to it, so a small cohort's individual behavior is not exposed.
   */
  measured: {
    label: typeof ENGAGEMENT_LABELS.measured;
    /** Null when suppressed (fewer than minCohort distinct readers opened). */
    opens: number | null;
    opensSuppressed: boolean;
    /** Distinct pseudonymous readers who opened this revision; suppressed below the cohort threshold. */
    distinctReaders: CohortCount;
    /** Null when suppressed (fewer than minCohort distinct readers viewed sections). */
    sectionViews: number | null;
    sectionViewsSuppressed: boolean;
    /** Null when suppressed (fewer than minCohort distinct readers opened evidence). */
    evidenceOpens: number | null;
    evidenceOpensSuppressed: boolean;
    /** Count only; question text is private to each reader. Null when fewer than minCohort distinct readers asked. */
    questionsAsked: number | null;
    questionsAskedSuppressed: boolean;
  };
  statements: {
    label: typeof ENGAGEMENT_LABELS.statements;
    submittedFeedback: number;
    unresolvedFeedback: number;
  };
}

export interface EngagementSummaryDto {
  briefingId: string;
  revisions: RevisionEngagementDto[];
  topics: {
    label: typeof ENGAGEMENT_LABELS.generated;
    items: { revisionNumber: number | null; topic: string; questionCount: number; readerCount: number; generatedAt: string }[];
    /** Questions withheld from topics; null (and `suppressedQuestionCountSuppressed`) below the cohort threshold. */
    suppressedQuestionCount: number | null;
    suppressedQuestionCountSuppressed: boolean;
  };
  minCohort: number;
  disclosure: string;
}

/** A count drawn from `readers` distinct readers, withheld below the cohort threshold. */
function cohortCount(value: number, readers: number, min: number): CohortCount {
  return readers >= min ? { value, suppressed: false } : { value: null, suppressed: true };
}

/**
 * Aggregate engagement for `view_engagement` holders. Activity counts are
 * observations, not comprehension or agreement; see `disclosure`.
 */
export async function getEngagementSummary(db: Database, ctx: RequestContext, briefingId: string): Promise<EngagementSummaryDto> {
  const c = parseCtx(ctx);
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertBriefingCapability(tx, c, briefingId, "view_engagement");
    const org = c.organizationId;
    const revs = await tx
      .select({
        id: briefingRevisions.id,
        number: briefingRevisions.number,
        publishedAt: publications.publishedAt,
        current: sql<boolean>`exists (select 1 from briefings b where b.organization_id = ${briefingRevisions.organizationId}
          and b.id = ${briefingRevisions.briefingId} and b.current_publication_id = ${publications.id})`,
      })
      .from(briefingRevisions)
      .leftJoin(publications, and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)))
      .where(and(eq(briefingRevisions.organizationId, org), eq(briefingRevisions.briefingId, briefingId)))
      .orderBy(asc(briefingRevisions.number));

    const ev = await tx.execute<{
      revision_id: string;
      opens: number;
      readers: number;
      sections: number;
      section_readers: number;
      evidence: number;
      evidence_readers: number;
    }>(sql`
      select revision_id,
        count(*) filter (where event_type = 'open')::int as opens,
        count(distinct session_id) filter (where event_type = 'open')::int as readers,
        count(*) filter (where event_type = 'section_view')::int as sections,
        count(distinct session_id) filter (where event_type = 'section_view')::int as section_readers,
        count(*) filter (where event_type = 'evidence_open')::int as evidence,
        count(distinct session_id) filter (where event_type = 'evidence_open')::int as evidence_readers
      from engagement_events
      where organization_id = ${org}::uuid and briefing_id = ${briefingId}::uuid
      group by revision_id`);
    const qs = await tx.execute<{ revision_id: string; n: number; readers: number }>(sql`
      select t.revision_id, count(*)::int as n, count(distinct t.reader_id)::int as readers
      from qa_messages m join qa_threads t on t.organization_id = m.organization_id and t.id = m.thread_id
      where m.organization_id = ${org}::uuid and t.briefing_id = ${briefingId}::uuid and m.role = 'reader'
      group by t.revision_id`);
    const fb = await tx.execute<{ revision_id: string; n: number; open: number }>(sql`
      select revision_id, count(*)::int as n,
        count(*) filter (where status in ('submitted', 'acknowledged'))::int as open
      from feedback where organization_id = ${org}::uuid and briefing_id = ${briefingId}::uuid
      group by revision_id`);
    const evBy = new Map(ev.rows.map((r) => [r.revision_id, r]));
    const qBy = new Map(qs.rows.map((r) => [r.revision_id, r]));
    const fBy = new Map(fb.rows.map((r) => [r.revision_id, r]));

    const insights = await loadLatestInsights(tx, org, briefingId);
    const numbers = await revisionNumbers(tx, org, briefingId);
    const min = ENGAGEMENT_SETTINGS.minCohort;

    return {
      briefingId,
      revisions: revs.map((r) => {
        const e = evBy.get(r.id);
        const q = qBy.get(r.id);
        const readers = e?.readers ?? 0;
        const opens = cohortCount(e?.opens ?? 0, readers, min);
        const sectionViews = cohortCount(e?.sections ?? 0, e?.section_readers ?? 0, min);
        const evidenceOpens = cohortCount(e?.evidence ?? 0, e?.evidence_readers ?? 0, min);
        const questionsAsked = cohortCount(q?.n ?? 0, q?.readers ?? 0, min);
        return {
          revisionNumber: r.number,
          publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
          isCurrent: r.current === true,
          measured: {
            label: ENGAGEMENT_LABELS.measured,
            opens: opens.value,
            opensSuppressed: opens.suppressed,
            distinctReaders: cohortCount(readers, readers, min),
            sectionViews: sectionViews.value,
            sectionViewsSuppressed: sectionViews.suppressed,
            evidenceOpens: evidenceOpens.value,
            evidenceOpensSuppressed: evidenceOpens.suppressed,
            questionsAsked: questionsAsked.value,
            questionsAskedSuppressed: questionsAsked.suppressed,
          },
          statements: {
            label: ENGAGEMENT_LABELS.statements,
            submittedFeedback: fBy.get(r.id)?.n ?? 0,
            unresolvedFeedback: fBy.get(r.id)?.open ?? 0,
          },
        };
      }),
      topics: {
        label: ENGAGEMENT_LABELS.generated,
        items: insights.topics.map((t) => ({
          revisionNumber: t.revisionId ? (numbers.get(t.revisionId) ?? null) : null,
          topic: t.topic,
          questionCount: t.questionCount,
          readerCount: t.readerCount,
          generatedAt: t.generatedAt,
        })),
        suppressedQuestionCount: insights.suppressedQuestionCount,
        suppressedQuestionCountSuppressed: insights.suppressedQuestionCountSuppressed,
      },
      minCohort: min,
      disclosure: ENGAGEMENT_DISCLOSURE,
    };
  });
}

// ---------------------------------------------------------------------------
// requestTopicSummary
// ---------------------------------------------------------------------------

/**
 * Enqueue a `summarize_topics` job for a revision (default: the current
 * publication). Deduplicated per revision and question count, so repeated
 * requests with no new questions do not re-run the analysis.
 */
export async function requestTopicSummary(
  db: Database,
  ctx: RequestContext,
  briefingId: string,
  opts: { revisionNumber?: number } = {},
): Promise<{ jobId: string | null; created: boolean; revisionNumber: number }> {
  const c = parseCtx(ctx);
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertBriefingCapability(tx, c, briefingId, "view_engagement");
    const rev = await resolveReadableRevision(tx, c, briefingId, opts.revisionNumber);
    const n = await tx.execute<{ n: number; readers: number }>(sql`
      select count(*)::int as n, count(distinct t.reader_id)::int as readers
      from qa_messages m join qa_threads t on t.organization_id = m.organization_id and t.id = m.thread_id
      where m.organization_id = ${c.organizationId}::uuid and t.revision_id = ${rev.revisionId}::uuid and m.role = 'reader'`);
    // The dedupe key (and so `created`) must not reveal small-cohort activity
    // (D07): below the cohort threshold every request maps to one key, so a
    // new question from one or two readers does not make a new job. At or
    // above it, the question count is already disclosed by the summary.
    const readers = n.rows[0]?.readers ?? 0;
    const count = readers >= ENGAGEMENT_SETTINGS.minCohort ? (n.rows[0]?.n ?? 0) : "below_cohort";
    const job = await enqueueJob(tx, {
      organizationId: c.organizationId,
      kind: "summarize_topics",
      payload: { briefingId, revisionId: rev.revisionId, requestedBy: c.userId },
      dedupeKey: dedupeKeys.summarizeTopics(c.organizationId, rev.revisionId, count),
    });
    if (job.created) {
      await recordAudit(tx, c, {
        action: "engagement.topic_summary_requested",
        targetType: "briefing",
        targetId: briefingId,
        revisionId: rev.revisionId,
      });
    }
    return { jobId: job.id, created: job.created, revisionNumber: rev.revisionNumber };
  });
}
