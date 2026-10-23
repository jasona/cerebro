import { PublishedBriefingDocument } from "@cerebro/briefing-schema";
import { briefingRevisions, feedback, qaThreads, users, withAuthContext, type Database, type Executor } from "@cerebro/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability, canReadRevision, resolveBriefingAccess } from "../access/index";
import { recordAudit } from "../audit";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { documentTargets, loadLatestInsights, resolveReadableRevision, type TopicInsightDto } from "./revision";
import { ENGAGEMENT_DISCLOSURE, ENGAGEMENT_LABELS } from "./settings";

const parseCtx = (ctx: RequestContext) => RequestContext.parse(ctx);
const authOf = (c: RequestContext) => ({ userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId });

export const FEEDBACK_TYPES = ["question", "comment", "concern", "correction"] as const;
export const FEEDBACK_STATUSES = ["submitted", "acknowledged", "resolved", "dismissed"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

// ---------------------------------------------------------------------------
// submitFeedback
// ---------------------------------------------------------------------------

export const SubmitFeedbackInput = z.object({
  briefingId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  blockId: z.string().min(1).max(100).optional(),
  type: z.enum(FEEDBACK_TYPES),
  /** Exactly the text the reader chose to submit. */
  text: z.string().trim().min(1).max(5000),
  /** The reader's own thread this came from. Only `text` is copied; the transcript stays private. */
  fromThreadId: z.string().uuid().optional(),
});
export type SubmitFeedbackInput = z.input<typeof SubmitFeedbackInput>;

export interface SubmitFeedbackResult {
  feedbackId: string;
  status: "submitted";
  revisionNumber: number;
}

/**
 * Explicit, attributed feedback bound to one revision (and optionally one
 * block). This is the only way a reader's words reach the author.
 */
export async function submitFeedback(db: Database, ctx: RequestContext, raw: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const c = parseCtx(ctx);
  const parsed = SubmitFeedbackInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid feedback.", { issues: parsed.error.issues.map((i) => i.message) });
  const input = parsed.data;

  return withAuthContext(db, authOf(c), async (tx) => {
    const rev = await resolveReadableRevision(tx, c, input.briefingId, input.revisionNumber);
    if (input.blockId) {
      const t = documentTargets(rev.document, rev.revisionId);
      if (!t.passages.has(input.blockId) && !t.sections.has(input.blockId) && !t.evidence.has(input.blockId)) {
        throw new DomainError("validation", "Unknown block for this revision.");
      }
    }
    if (input.fromThreadId) {
      const [t] = await tx
        .select({ id: qaThreads.id, briefingId: qaThreads.briefingId })
        .from(qaThreads)
        .where(and(eq(qaThreads.organizationId, c.organizationId), eq(qaThreads.id, input.fromThreadId), eq(qaThreads.readerId, c.userId)));
      if (!t || t.briefingId !== input.briefingId) throw new DomainError("not_found", "Conversation not found.");
    }
    const [row] = await tx
      .insert(feedback)
      .values({
        organizationId: c.organizationId,
        briefingId: input.briefingId,
        revisionId: rev.revisionId,
        blockKey: input.blockId ?? null,
        authorId: c.userId,
        type: input.type,
        text: input.text,
        status: "submitted",
        qaThreadId: input.fromThreadId ?? null,
      })
      .returning({ id: feedback.id });
    await recordAudit(tx, c, {
      action: "feedback.submitted",
      targetType: "feedback",
      targetId: row!.id,
      revisionId: rev.revisionId,
      metadata: { briefingId: input.briefingId, type: input.type, fromThread: !!input.fromThreadId },
    });
    return { feedbackId: row!.id, status: "submitted", revisionNumber: rev.revisionNumber };
  });
}

// ---------------------------------------------------------------------------
// Feedback DTOs
// ---------------------------------------------------------------------------

export interface FeedbackDto {
  id: string;
  revisionNumber: number;
  type: FeedbackType;
  text: string;
  status: FeedbackStatus;
  submittedBy: { userId: string; displayName: string };
  submittedAt: string;
  updatedAt: string;
  /** Block context from the revision the feedback was given on, even if a later revision removed the block. */
  block: {
    blockId: string;
    sectionTitle: string | null;
    title: string;
    excerpt: string;
    presentInCurrentRevision: boolean;
  } | null;
  resolutionRevisionNumber: number | null;
  /** Always "reader_statements": text a reader explicitly submitted. */
  label: typeof ENGAGEMENT_LABELS.statements;
}

const EXCERPT = 240;
const clip = (s: string) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT - 1)}…` : s);

async function loadFeedback(
  tx: Executor,
  c: RequestContext,
  where: { briefingId: string; authorId?: string },
  currentRevisionId: string | null,
  /** When set, revision content (block excerpts, titles) is returned only for these revisions. */
  readableRevisionIds?: ReadonlySet<string>,
): Promise<FeedbackDto[]> {
  const rows = await tx
    .select({
      id: feedback.id,
      revisionId: feedback.revisionId,
      revisionNumber: briefingRevisions.number,
      blockKey: feedback.blockKey,
      type: feedback.type,
      text: feedback.text,
      status: feedback.status,
      authorId: feedback.authorId,
      authorName: users.displayName,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
      resolutionRevisionId: feedback.resolutionRevisionId,
    })
    .from(feedback)
    .innerJoin(
      briefingRevisions,
      and(eq(briefingRevisions.organizationId, feedback.organizationId), eq(briefingRevisions.id, feedback.revisionId)),
    )
    .leftJoin(users, eq(users.id, feedback.authorId))
    .where(
      and(
        eq(feedback.organizationId, c.organizationId),
        eq(feedback.briefingId, where.briefingId),
        ...(where.authorId ? [eq(feedback.authorId, where.authorId)] : []),
      ),
    )
    .orderBy(desc(feedback.createdAt));

  const numbers = await revisionNumbers(tx, c.organizationId, where.briefingId);
  const revisionIds = [...new Set([...rows.map((r) => r.revisionId), ...(currentRevisionId ? [currentRevisionId] : [])])].filter(
    (id) => !readableRevisionIds || readableRevisionIds.has(id),
  );
  const docs = revisionIds.length
    ? await tx
        .select({ id: briefingRevisions.id, documentJson: briefingRevisions.documentJson })
        .from(briefingRevisions)
        .where(and(eq(briefingRevisions.organizationId, c.organizationId), inArray(briefingRevisions.id, revisionIds)))
    : [];
  const targets = new Map<string, ReturnType<typeof documentTargets>>();
  for (const d of docs) {
    const doc = PublishedBriefingDocument.safeParse(d.documentJson);
    if (doc.success) targets.set(d.id, documentTargets(doc.data, d.id));
  }
  const current = currentRevisionId ? targets.get(currentRevisionId) : undefined;
  const has = (t: ReturnType<typeof documentTargets> | undefined, key: string) =>
    !!t && (t.passages.has(key) || t.sections.has(key) || t.evidence.has(key));

  return rows.map((r) => {
    let block: FeedbackDto["block"] = null;
    if (r.blockKey) {
      const t = targets.get(r.revisionId);
      const p = t?.passages.get(r.blockKey);
      const sectionTitle = p?.sectionId ? (t?.sections.get(p.sectionId) ?? null) : (t?.sections.get(r.blockKey) ?? null);
      block = {
        blockId: r.blockKey,
        sectionTitle,
        title: p?.title ?? sectionTitle ?? r.blockKey,
        excerpt: p ? clip(p.text) : "",
        presentInCurrentRevision: has(current, r.blockKey),
      };
    }
    return {
      id: r.id,
      revisionNumber: r.revisionNumber,
      type: r.type as FeedbackType,
      text: r.text,
      status: r.status as FeedbackStatus,
      submittedBy: { userId: r.authorId, displayName: r.authorName ?? "Unknown reader" },
      submittedAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      block,
      resolutionRevisionNumber: r.resolutionRevisionId ? (numbers.get(r.resolutionRevisionId) ?? null) : null,
      label: ENGAGEMENT_LABELS.statements,
    };
  });
}

// ---------------------------------------------------------------------------
// Author views
// ---------------------------------------------------------------------------

/** Submitted feedback for users with `view_engagement` (owner, editor, publisher). */
export async function listSubmittedFeedback(db: Database, ctx: RequestContext, briefingId: string): Promise<FeedbackDto[]> {
  const c = parseCtx(ctx);
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertBriefingCapability(tx, c, briefingId, "view_engagement");
    const access = await resolveBriefingAccess(tx, c, briefingId);
    return loadFeedback(tx, c, { briefingId }, access?.currentRevisionId ?? null);
  });
}

/** The caller's own submissions on a briefing (every reader may see their own). */
export async function listMyFeedback(db: Database, ctx: RequestContext, briefingId: string): Promise<FeedbackDto[]> {
  const c = parseCtx(ctx);
  return withAuthContext(db, authOf(c), async (tx) => {
    const access = await resolveBriefingAccess(tx, c, briefingId);
    if (!access) throw new DomainError("not_found", "Briefing not found.");
    // The reader's own text is always theirs; revision content only while they can still read it.
    const own = await tx
      .selectDistinct({ revisionId: feedback.revisionId })
      .from(feedback)
      .where(and(eq(feedback.organizationId, c.organizationId), eq(feedback.briefingId, briefingId), eq(feedback.authorId, c.userId)));
    const readable = new Set<string>();
    for (const r of own) if (await canReadRevision(tx, c, briefingId, r.revisionId)) readable.add(r.revisionId);
    const current = access.capabilities.has("read") ? access.currentRevisionId : null;
    if (current) readable.add(current);
    return loadFeedback(tx, c, { briefingId, authorId: c.userId }, current, readable);
  });
}

export const ResolveFeedbackInput = z.object({
  feedbackId: z.string().uuid(),
  status: z.enum(FEEDBACK_STATUSES),
  /** The revision that addressed the feedback. */
  resolutionRef: z.object({ revisionNumber: z.number().int().positive() }).optional(),
});
export type ResolveFeedbackInput = z.input<typeof ResolveFeedbackInput>;

/** Change a feedback item's status (view_engagement holders). */
export async function resolveFeedback(
  db: Database,
  ctx: RequestContext,
  raw: ResolveFeedbackInput,
): Promise<{ feedbackId: string; status: FeedbackStatus; resolutionRevisionNumber: number | null }> {
  const c = parseCtx(ctx);
  const parsed = ResolveFeedbackInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid feedback update.");
  const input = parsed.data;
  return withAuthContext(db, authOf(c), async (tx) => {
    const [fb] = await tx
      .select({ id: feedback.id, briefingId: feedback.briefingId })
      .from(feedback)
      .where(and(eq(feedback.organizationId, c.organizationId), eq(feedback.id, input.feedbackId)));
    if (!fb) throw new DomainError("not_found", "Feedback not found.");
    try {
      await assertBriefingCapability(tx, c, fb.briefingId, "view_engagement");
    } catch (e) {
      // Do not reveal that the feedback exists to people who cannot manage it.
      throw new DomainError("not_found", "Feedback not found.", { cause: (e as DomainError).code });
    }
    let resolutionRevisionId: string | null = null;
    if (input.resolutionRef) {
      const [r] = await tx
        .select({ id: briefingRevisions.id })
        .from(briefingRevisions)
        .where(
          and(
            eq(briefingRevisions.organizationId, c.organizationId),
            eq(briefingRevisions.briefingId, fb.briefingId),
            eq(briefingRevisions.number, input.resolutionRef.revisionNumber),
          ),
        );
      if (!r) throw new DomainError("validation", "Unknown resolution revision.");
      resolutionRevisionId = r.id;
    }
    await tx
      .update(feedback)
      .set({
        status: input.status,
        ...(input.resolutionRef ? { resolutionRevisionId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(feedback.id, fb.id));
    await recordAudit(tx, c, {
      action: "feedback.status_changed",
      targetType: "feedback",
      targetId: fb.id,
      metadata: { status: input.status, resolutionRevisionNumber: input.resolutionRef?.revisionNumber ?? null },
    });
    return { feedbackId: fb.id, status: input.status, resolutionRevisionNumber: input.resolutionRef?.revisionNumber ?? null };
  });
}

export interface AuthorTopicDto extends TopicInsightDto {
  revisionNumber: number | null;
}

export interface AuthorFeedbackDto {
  briefingId: string;
  /** Explicitly submitted, attributed reader statements. */
  feedback: FeedbackDto[];
  /** Generated topic summaries above the cohort threshold. Never raw questions. */
  topics: AuthorTopicDto[];
  /** Questions withheld from topics; null (and `suppressedQuestionCountSuppressed`) below the cohort threshold. */
  suppressedQuestionCount: number | null;
  suppressedQuestionCountSuppressed: boolean;
  disclosure: string;
}

/**
 * For the MCP `get_author_feedback` tool and the author view: submitted
 * feedback plus permitted aggregate topics. Never private Q&A text.
 */
export async function getAuthorFeedback(db: Database, ctx: RequestContext, raw: { briefingId: string }): Promise<AuthorFeedbackDto> {
  const c = parseCtx(ctx);
  const { briefingId } = z.object({ briefingId: z.string().uuid() }).parse(raw);
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertBriefingCapability(tx, c, briefingId, "view_engagement");
    const access = await resolveBriefingAccess(tx, c, briefingId);
    const items = await loadFeedback(tx, c, { briefingId }, access?.currentRevisionId ?? null);
    const insights = await loadLatestInsights(tx, c.organizationId, briefingId);
    const numbers = await revisionNumbers(tx, c.organizationId, briefingId);
    return {
      briefingId,
      feedback: items,
      topics: insights.topics.map((t) => ({ ...t, revisionNumber: t.revisionId ? (numbers.get(t.revisionId) ?? null) : null })),
      suppressedQuestionCount: insights.suppressedQuestionCount,
      suppressedQuestionCountSuppressed: insights.suppressedQuestionCountSuppressed,
      disclosure: ENGAGEMENT_DISCLOSURE,
    };
  });
}

export async function revisionNumbers(tx: Executor, organizationId: string, briefingId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: briefingRevisions.id, number: briefingRevisions.number })
    .from(briefingRevisions)
    .where(and(eq(briefingRevisions.organizationId, organizationId), eq(briefingRevisions.briefingId, briefingId)));
  return new Map(rows.map((r) => [r.id, r.number]));
}
