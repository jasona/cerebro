import { AnswerTask, runAnswer, type AiErrorCategory, type AiRunRecord, type AnswerOutput, type AnswerPart } from "@cerebro/ai";
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
import { insertAiRun } from "../jobs/summarize-topics";
import { allowedEmbeddings, getAiRuntimeOrNull, resolveOrgAiPolicy, type AiRuntime } from "./ai-runtime";
import { embedQuestion, retrieveRevisionChunks, type QueryEmbedding, type RetrievedChunk } from "./retrieval";
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
// askQuestion
// ---------------------------------------------------------------------------

export { tsQueryFor } from "./retrieval";

export interface AskQuestionDeps {
  /** Override the AI registry (tests). Defaults to the process AI runtime. */
  registry?: AiRuntime["registry"];
  /** Override the answer timeout (tests). Defaults to ENGAGEMENT_SETTINGS.answerTimeoutMs. */
  timeoutMs?: number;
}

/**
 * Failures after which the next approved provider is tried. The registry's
 * candidates are already limited to providers the organization allows, so a
 * fallback never sends data anywhere new; with the default routing the last
 * candidate is the local deterministic provider (principle 6).
 */
const FALLBACK_ON: ReadonlySet<AiErrorCategory> = new Set(["unavailable", "timeout", "provider_error", "invalid_output", "unsupported"]);

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

  // Hybrid retrieval embeds the question first, outside any transaction, and
  // only with an embedding provider the organization allows. Any failure
  // leaves retrieval on full-text.
  const runtime = await getAiRuntimeOrNull();
  let queryEmbedding: QueryEmbedding | null = null;
  if (runtime?.retrievalMode === "hybrid" && runtime.embeddings) {
    const policy = await withAuthContext(db, authOf(c), (tx) => resolveOrgAiPolicy(tx, c.organizationId));
    queryEmbedding = await embedQuestion(allowedEmbeddings(runtime, policy), input.question);
  }

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

    const chunks = await retrieveRevisionChunks(tx, c.organizationId, rev.revisionId, input.question, {
      mode: runtime?.retrievalMode ?? "fts",
      queryEmbedding,
      titleOf: (key) => targets.passages.get(key)?.title,
    });
    await tx.insert(qaMessages).values({
      organizationId: c.organizationId,
      threadId: thread.id,
      revisionId: rev.revisionId,
      role: "reader",
      content: input.question,
      generationStatus: "complete",
    });
    const policy = await resolveOrgAiPolicy(tx, c.organizationId);
    return {
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
  const registry = deps.registry ?? runtime?.registry;
  let output: AnswerOutput | null = null;
  const records: AiRunRecord[] = [];
  const candidates = registry ? registry.candidates("answer", prep.policy) : [];
  for (const provider of candidates) {
    const res = await runAnswer(
      provider,
      {
        question: input.question,
        revisionId: prep.revisionId,
        ...(input.focusBlockId ? { focusBlockId: input.focusBlockId } : {}),
        ...(prep.perspective ? { perspective: prep.perspective } : {}),
        passages: prep.chunks.map((ch) => ch.passage),
      },
      { timeoutMs: deps.timeoutMs ?? ENGAGEMENT_SETTINGS.answerTimeoutMs },
    );
    records.push(res.record);
    if (res.ok) {
      output = res.output;
      break;
    }
    if (!FALLBACK_ON.has(res.error.category)) break;
  }
  if (records.length === 0) {
    records.push({
      task: "answer",
      provider: "none",
      model: "none",
      promptVersion: AnswerTask.promptVersion,
      status: "failed",
      latencyMs: 0,
      usage: {},
      errorCategory: "unavailable",
      revisionId: prep.revisionId,
    });
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
    let aiRunId: string | null = null;
    for (const record of records) aiRunId = await insertAiRun(tx, c.organizationId, c.userId, record);
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
