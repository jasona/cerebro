import {
  AnswerTask,
  RetrievedPassage,
  runAnswer,
  type AiRunRecord,
  type AnswerOutput,
  type AnswerPart,
} from "@cerebro/ai";
import { BlockId, PerspectiveId, PublishedBriefingDocument } from "@cerebro/briefing-schema";
import {
  answerCitations,
  briefingRevisions,
  qaMessages,
  qaThreads,
  revisionEvidence,
  withAuthContext,
  type Database,
  type Executor,
} from "@cerebro/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { canReadRevision, resolveBriefingAccess } from "../access/index";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { isRevisionIndexed } from "../jobs/kinds";
import { checkAiUsage, recordAiRun } from "../ops/ai-usage";
import { enforceRateLimit } from "../ops/rate-limit";
import { getAiRegistry, resolveOrgAiPolicy } from "./ai-runtime";
import { documentTargets, resolveReadableRevision, type DocumentTargets } from "./revision";
import { ENGAGEMENT_SETTINGS } from "./settings";

const parseCtx = (ctx: RequestContext) => RequestContext.parse(ctx);
const authOf = (c: RequestContext) => ({ userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId });

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type AskStatus = "answered" | "insufficient" | "refused" | "failed" | "preparing";

export interface CitationDto {
  kind: "block" | "evidence";
  /** Block key within the revision (`blk_…`, or `position`/`context`/`request`/`psp_…`/`open_questions`). */
  blockId?: string;
  /** Document evidence id (`ev_…`) within the revision's approved evidence. */
  evidenceId?: string;
  title: string;
  /** Approved excerpt (evidence citations only). */
  excerpt?: string;
}

export interface AskQuestionResult {
  /** Null only when status is "preparing" and no thread existed. */
  threadId: string | null;
  status: AskStatus;
  parts: AnswerPart[];
  citations: CitationDto[];
  revisionNumber: number;
  /** What the material does not cover, or why no answer is available. */
  missing?: string;
}

export const AskQuestionInput = z.object({
  briefingId: z.string().uuid(),
  /** Pinned revision. Omitted: the current publication. */
  revisionNumber: z.number().int().positive().optional(),
  question: z.string().trim().min(1).max(2000),
  focusBlockId: BlockId.optional(),
  perspectiveId: PerspectiveId.optional(),
  /** Continue a thread. It must be the caller's own and bound to the same revision. */
  threadId: z.string().uuid().optional(),
});
export type AskQuestionInput = z.input<typeof AskQuestionInput>;

/** Stored form of an assistant message (`qa_messages.content`). */
interface StoredAnswer {
  status: Exclude<AskStatus, "preparing">;
  parts: AnswerPart[];
  missing?: string;
}

const UNAVAILABLE =
  "Answers are unavailable right now. The briefing and its approved evidence remain available to read, and you can submit your question to the author.";

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

interface RetrievedChunk {
  passage: RetrievedPassage;
  /** revision_evidence.id for evidence passages. */
  evidenceRowId: string | null;
  excerpt: string | null;
}

/** Safe OR-query of the question's words: only [a-z0-9] tokens reach to_tsquery. */
export function tsQueryFor(question: string): string | null {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 2).slice(0, 32);
  return words.length ? words.join(" | ") : null;
}

/**
 * Full-text retrieval (T20) from `retrieval_chunks` for exactly this
 * organization + revision: FTS-ranked chunks first, then the rest of the same
 * revision by document order up to top-k, so the answerer's relevance
 * statistics see a representative corpus. Nothing outside the revision's
 * published blocks and approved evidence is ever reachable from here.
 */
async function retrievePassages(
  tx: Executor,
  organizationId: string,
  revisionId: string,
  question: string,
  targets: DocumentTargets,
): Promise<RetrievedChunk[]> {
  const q = tsQueryFor(question);
  const rank = q ? sql`ts_rank_cd(c.tsv, to_tsquery('english', ${q}))` : sql`0`;
  const res = await tx.execute<{
    kind: "block" | "evidence";
    block_key: string | null;
    evidence_row_id: string | null;
    evidence_key: string | null;
    evidence_title: string | null;
    evidence_excerpt: string | null;
    text: string;
  }>(sql`
    select c.kind, c.block_key, c.evidence_id as evidence_row_id, c.text,
           e.evidence_key, e.title as evidence_title, e.excerpt as evidence_excerpt
    from retrieval_chunks c
    left join revision_evidence e
      on e.organization_id = c.organization_id and e.revision_id = c.revision_id and e.id = c.evidence_id
    where c.organization_id = ${organizationId}::uuid and c.revision_id = ${revisionId}::uuid
    order by ${rank} desc, c.ordinal
    limit ${ENGAGEMENT_SETTINGS.retrievalTopK}`);

  const out: RetrievedChunk[] = [];
  for (const r of res.rows) {
    if (r.kind === "evidence") {
      if (!r.evidence_key || !r.evidence_row_id) continue;
      const p = RetrievedPassage.safeParse({
        id: r.evidence_key,
        kind: "evidence",
        evidenceId: r.evidence_key,
        revisionId,
        text: r.text,
        title: r.evidence_title ?? "Evidence",
      });
      if (p.success) out.push({ passage: p.data, evidenceRowId: r.evidence_row_id, excerpt: r.evidence_excerpt });
    } else if (r.block_key) {
      const blockId = BlockId.safeParse(r.block_key).success ? r.block_key : undefined;
      const p = RetrievedPassage.safeParse({
        id: r.block_key,
        kind: "block",
        ...(blockId ? { blockId } : {}),
        revisionId,
        text: r.text,
        title: targets.passages.get(r.block_key)?.title ?? "Briefing",
      });
      if (p.success) out.push({ passage: p.data, evidenceRowId: null, excerpt: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// askQuestion
// ---------------------------------------------------------------------------

export interface AskQuestionDeps {
  /** Override the AI registry (tests). Defaults to getAiRegistry(). */
  registry?: ReturnType<typeof getAiRegistry>;
}

/**
 * Ask a grounded question about one exact revision.
 *
 * - Requires read on that revision; pinned revisions are used only as pinned.
 * - Threads are private to the asker and permanently bound to one revision:
 *   continuing a thread on another revision is a `conflict` error.
 * - An unindexed revision returns `preparing`; there is never a fallback to another revision.
 * - Retrieval is limited to this revision's published blocks and approved evidence.
 * - Citations are re-validated against the retrieved passages and stored
 *   only for this revision. AI failure yields status `failed`; reading is unaffected.
 */
export async function askQuestion(
  db: Database,
  ctx: RequestContext,
  raw: AskQuestionInput,
  deps: AskQuestionDeps = {},
): Promise<AskQuestionResult> {
  const c = parseCtx(ctx);
  const parsed = AskQuestionInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid question.", { issues: parsed.error.issues.map((i) => i.message) });
  const input = parsed.data;
  await enforceRateLimit(db, c, "qa");

  const prep = await withAuthContext(db, authOf(c), async (tx) => {
    const rev = await resolveReadableRevision(tx, c, input.briefingId, input.revisionNumber);
    const targets = documentTargets(rev.document, rev.revisionId);

    let thread: { id: string; perspectiveKey: string | null } | null = null;
    if (input.threadId) {
      const [t] = await tx
        .select({ id: qaThreads.id, briefingId: qaThreads.briefingId, revisionId: qaThreads.revisionId, perspectiveKey: qaThreads.perspectiveKey })
        .from(qaThreads)
        .where(and(eq(qaThreads.organizationId, c.organizationId), eq(qaThreads.id, input.threadId), eq(qaThreads.readerId, c.userId)));
      if (!t || t.briefingId !== input.briefingId) throw new DomainError("not_found", "Conversation not found.");
      if (t.revisionId !== rev.revisionId) {
        throw new DomainError("conflict", "This conversation belongs to another revision. Start a new conversation for this revision.", {
          reason: "thread_revision_mismatch",
        });
      }
      thread = { id: t.id, perspectiveKey: t.perspectiveKey };
    }

    const perspectiveId = input.perspectiveId ?? thread?.perspectiveKey ?? undefined;
    if (perspectiveId && !targets.perspectives.has(perspectiveId)) throw new DomainError("validation", "Unknown perspective.");
    if (input.focusBlockId && !targets.passages.has(input.focusBlockId)) throw new DomainError("validation", "Unknown block.");

    const recent = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
      from qa_messages m
      join qa_threads t on t.organization_id = m.organization_id and t.id = m.thread_id
      where m.organization_id = ${c.organizationId}::uuid
        and t.reader_id = ${c.userId}::uuid
        and t.briefing_id = ${input.briefingId}::uuid
        and m.role = 'reader'
        and m.created_at > now() - interval '1 hour'`);
    if ((recent.rows[0]?.n ?? 0) >= ENGAGEMENT_SETTINGS.askRateLimitPerHour) {
      throw new DomainError("rate_limited", "Too many questions on this briefing in the last hour. Try again later.");
    }

    if (!(await isRevisionIndexed(tx, c.organizationId, rev.revisionId))) {
      return { preparing: true as const, threadId: thread?.id ?? null, revisionNumber: rev.revisionNumber };
    }

    if (!thread) {
      const [t] = await tx
        .insert(qaThreads)
        .values({
          organizationId: c.organizationId,
          briefingId: input.briefingId,
          revisionId: rev.revisionId,
          readerId: c.userId,
          perspectiveKey: perspectiveId ?? null,
          visibility: "private",
        })
        .returning({ id: qaThreads.id });
      thread = { id: t!.id, perspectiveKey: perspectiveId ?? null };
    }

    const chunks = await retrievePassages(tx, c.organizationId, rev.revisionId, input.question, targets);
    await tx.insert(qaMessages).values({
      organizationId: c.organizationId,
      threadId: thread.id,
      revisionId: rev.revisionId,
      role: "reader",
      content: input.question,
      generationStatus: "complete",
    });
    const policy = await resolveOrgAiPolicy(tx, c.organizationId);
    const usage = await checkAiUsage(tx, c.organizationId);
    return {
      usageLimited: !usage.allowed,
      preparing: false as const,
      threadId: thread.id,
      revisionId: rev.revisionId,
      revisionNumber: rev.revisionNumber,
      perspective: perspectiveId ? { id: perspectiveId, label: targets.perspectives.get(perspectiveId)! } : undefined,
      chunks,
      policy,
    };
  });

  if (prep.preparing) {
    return {
      threadId: prep.threadId,
      status: "preparing",
      parts: [],
      citations: [],
      revisionNumber: prep.revisionNumber,
      missing: "This revision is still being prepared for questions. Try again shortly.",
    };
  }

  // The model call happens outside any transaction (PGlite serializes them).
  const registry = deps.registry ?? getAiRegistry();
  let output: AnswerOutput | null = null;
  let record: AiRunRecord;
  // Over the organization's AI usage limit, answer exactly as during an
  // outage (principle 6): no provider call, reading is unaffected.
  const candidates = prep.usageLimited ? [] : registry.candidates("answer", prep.policy);
  if (candidates.length === 0) {
    record = {
      task: "answer",
      provider: "none",
      model: "none",
      promptVersion: AnswerTask.promptVersion,
      status: "failed",
      latencyMs: 0,
      usage: {},
      errorCategory: prep.usageLimited ? "usage_limited" : "unavailable",
      revisionId: prep.revisionId,
    };
  } else {
    const res = await runAnswer(
      candidates[0]!,
      {
        question: input.question,
        revisionId: prep.revisionId,
        ...(input.focusBlockId ? { focusBlockId: input.focusBlockId } : {}),
        ...(prep.perspective ? { perspective: prep.perspective } : {}),
        passages: prep.chunks.map((ch) => ch.passage),
      },
      { timeoutMs: ENGAGEMENT_SETTINGS.answerTimeoutMs },
    );
    record = res.record;
    if (res.ok) output = res.output;
  }

  // Bind citations to passages retrieved for this revision only.
  const byPassage = new Map(prep.chunks.map((ch) => [ch.passage.id, ch]));
  const cited: typeof prep.chunks = [];
  if (output) {
    const ids = new Set<string>([...output.citations.map((x) => x.passageId), ...output.answer.flatMap((p) => p.citations)]);
    for (const id of ids) {
      const ch = byPassage.get(id);
      if (ch && ch.passage.revisionId === prep.revisionId) cited.push(ch);
    }
  }

  const stored: StoredAnswer = output
    ? { status: output.status, parts: output.answer, ...(output.missing ? { missing: output.missing } : {}) }
    : { status: "failed", parts: [], missing: UNAVAILABLE };
  const generationStatus = stored.status === "answered" ? "complete" : stored.status === "failed" ? "failed" : "abstained";

  await withAuthContext(db, authOf(c), async (tx) => {
    const [t] = await tx
      .select({ id: qaThreads.id })
      .from(qaThreads)
      .where(
        and(
          eq(qaThreads.organizationId, c.organizationId),
          eq(qaThreads.id, prep.threadId),
          eq(qaThreads.readerId, c.userId),
          eq(qaThreads.revisionId, prep.revisionId),
        ),
      );
    if (!t) throw new DomainError("not_found", "Conversation not found.");
    const aiRunId = await recordAiRun(tx, c.organizationId, c.userId, record);
    const [msg] = await tx
      .insert(qaMessages)
      .values({
        organizationId: c.organizationId,
        threadId: prep.threadId,
        revisionId: prep.revisionId,
        role: "assistant",
        content: JSON.stringify(stored),
        generationStatus,
        aiRunId,
      })
      .returning({ id: qaMessages.id });
    if (cited.length) {
      await tx.insert(answerCitations).values(
        cited.map((ch) => ({
          organizationId: c.organizationId,
          messageId: msg!.id,
          revisionId: prep.revisionId,
          ...(ch.passage.kind === "evidence" ? { evidenceId: ch.evidenceRowId } : { blockKey: ch.passage.id }),
        })),
      );
    }
    await tx.update(qaThreads).set({ updatedAt: sql`now()` }).where(eq(qaThreads.id, prep.threadId));
  });

  return {
    threadId: prep.threadId,
    status: stored.status,
    parts: stored.parts,
    citations: cited.map(toCitationDto),
    revisionNumber: prep.revisionNumber,
    ...(stored.missing ? { missing: stored.missing } : {}),
  };
}

function toCitationDto(ch: RetrievedChunk): CitationDto {
  return ch.passage.kind === "evidence"
    ? { kind: "evidence", evidenceId: ch.passage.evidenceId!, title: ch.passage.title, ...(ch.excerpt ? { excerpt: ch.excerpt } : {}) }
    : { kind: "block", blockId: ch.passage.id, title: ch.passage.title };
}

// ---------------------------------------------------------------------------
// getMyThreads
// ---------------------------------------------------------------------------

export interface ThreadMessageDto {
  id: string;
  role: "reader" | "assistant";
  /** Reader messages: the question. */
  text?: string;
  /** Assistant messages. */
  status?: Exclude<AskStatus, "preparing">;
  parts?: AnswerPart[];
  missing?: string;
  citations: CitationDto[];
  createdAt: string;
}

export interface ThreadDto {
  threadId: string;
  revisionNumber: number;
  perspectiveId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessageDto[];
}

/**
 * The caller's own private threads on a briefing — never anyone else's,
 * whatever their role. Threads on revisions the caller can no longer read are omitted.
 */
export async function getMyThreads(db: Database, ctx: RequestContext, briefingId: string): Promise<ThreadDto[]> {
  const c = parseCtx(ctx);
  if (!z.string().uuid().safeParse(briefingId).success) throw new DomainError("not_found", "Briefing not found.");
  return withAuthContext(db, authOf(c), async (tx) => {
    if (!(await resolveBriefingAccess(tx, c, briefingId))) throw new DomainError("not_found", "Briefing not found.");
    const threads = await tx
      .select({
        id: qaThreads.id,
        revisionId: qaThreads.revisionId,
        perspectiveKey: qaThreads.perspectiveKey,
        createdAt: qaThreads.createdAt,
        updatedAt: qaThreads.updatedAt,
        number: briefingRevisions.number,
        documentJson: briefingRevisions.documentJson,
      })
      .from(qaThreads)
      .innerJoin(
        briefingRevisions,
        and(eq(briefingRevisions.organizationId, qaThreads.organizationId), eq(briefingRevisions.id, qaThreads.revisionId)),
      )
      .where(
        and(eq(qaThreads.organizationId, c.organizationId), eq(qaThreads.briefingId, briefingId), eq(qaThreads.readerId, c.userId)),
      )
      .orderBy(desc(qaThreads.updatedAt));

    const out: ThreadDto[] = [];
    for (const t of threads) {
      if (!(await canReadRevision(tx, c, briefingId, t.revisionId))) continue;
      const msgs = await tx
        .select()
        .from(qaMessages)
        .where(and(eq(qaMessages.organizationId, c.organizationId), eq(qaMessages.threadId, t.id)))
        .orderBy(asc(qaMessages.createdAt), asc(qaMessages.id));
      const ids = msgs.filter((m) => m.role === "assistant").map((m) => m.id);
      const cites = ids.length
        ? await tx
            .select({
              messageId: answerCitations.messageId,
              blockKey: answerCitations.blockKey,
              evidenceKey: revisionEvidence.evidenceKey,
              evidenceTitle: revisionEvidence.title,
              excerpt: revisionEvidence.excerpt,
            })
            .from(answerCitations)
            .leftJoin(
              revisionEvidence,
              and(
                eq(revisionEvidence.organizationId, answerCitations.organizationId),
                eq(revisionEvidence.revisionId, answerCitations.revisionId),
                eq(revisionEvidence.id, answerCitations.evidenceId),
              ),
            )
            .where(
              and(
                eq(answerCitations.organizationId, c.organizationId),
                eq(answerCitations.revisionId, t.revisionId),
                inArray(answerCitations.messageId, ids),
              ),
            )
        : [];
      const doc = PublishedBriefingDocument.safeParse(t.documentJson);
      const titles = doc.success ? documentTargets(doc.data, t.revisionId).passages : new Map<string, { title: string }>();

      out.push({
        threadId: t.id,
        revisionNumber: t.number,
        perspectiveId: t.perspectiveKey,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        messages: msgs.map((m): ThreadMessageDto => {
          const citations: CitationDto[] = cites
            .filter((x) => x.messageId === m.id)
            .map((x) =>
              x.blockKey
                ? { kind: "block", blockId: x.blockKey, title: titles.get(x.blockKey)?.title ?? "Briefing" }
                : { kind: "evidence", evidenceId: x.evidenceKey ?? "", title: x.evidenceTitle ?? "Evidence", ...(x.excerpt ? { excerpt: x.excerpt } : {}) },
            );
          if (m.role === "reader") {
            return { id: m.id, role: "reader", text: m.content, citations: [], createdAt: m.createdAt.toISOString() };
          }
          let stored: StoredAnswer = { status: "failed", parts: [] };
          try {
            stored = JSON.parse(m.content) as StoredAnswer;
          } catch {
            // Unreadable stored answer: report as failed rather than guessing.
          }
          return {
            id: m.id,
            role: "assistant",
            status: stored.status,
            parts: stored.parts ?? [],
            ...(stored.missing ? { missing: stored.missing } : {}),
            citations,
            createdAt: m.createdAt.toISOString(),
          };
        }),
      });
    }
    return out;
  });
}
