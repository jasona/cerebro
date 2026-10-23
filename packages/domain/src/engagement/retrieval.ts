import { AiError, RetrievedPassage, RRF_K, type EmbeddingProvider, type RetrievalMode } from "@cerebro/ai";
import { BlockId } from "@cerebro/briefing-schema";
import type { Executor } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { AI_SETTINGS } from "./ai-runtime";
import { ENGAGEMENT_SETTINGS } from "./settings";

/**
 * Reader retrieval over `retrieval_chunks` for exactly one organization +
 * revision. The table holds only the revision's published blocks and its
 * approved evidence (see jobs/index-revision.ts); `source_chunks` are never
 * read here, in either mode.
 *
 * - `fts` (default, T20): chunks matching the question's full-text query by
 *   `ts_rank_cd`, then the rest of the revision in document order.
 * - `hybrid`: reciprocal rank fusion (k = RRF_K) of the full-text ranking and
 *   a cosine-distance ranking over chunks embedded with the same model and
 *   dimensions as the question vector. Without a question vector, or when
 *   the revision has no matching embeddings, it is exactly `fts`.
 *
 * Both modes return up to top-k chunks, padded in document order, so the
 * answerer's relevance statistics see a representative corpus. Ranking never
 * widens the set: every predicate is scoped to the organization and revision.
 */

export interface RetrievedChunk {
  passage: RetrievedPassage;
  /** revision_evidence.id for evidence passages. */
  evidenceRowId: string | null;
  excerpt: string | null;
}

export interface QueryEmbedding {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface RetrieveOptions {
  mode?: RetrievalMode;
  queryEmbedding?: QueryEmbedding | null;
  topK?: number;
  /** Reader-facing title for a block key (published document targets). */
  titleOf?: (blockKey: string) => string | undefined;
}

/** Safe OR-query of the question's words: only [a-z0-9] tokens reach to_tsquery. */
export function tsQueryFor(question: string): string | null {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 2).slice(0, 32);
  return words.length ? words.join(" | ") : null;
}

/** pgvector text literal. Only finite numbers reach SQL. */
export function vectorLiteral(v: readonly number[]): string {
  if (!v.every((x) => Number.isFinite(x))) throw new AiError("invalid_output", "embedding contains non-finite values");
  return `[${v.join(",")}]`;
}

export async function retrieveRevisionChunks(
  tx: Executor,
  organizationId: string,
  revisionId: string,
  question: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const q = tsQueryFor(question);
  const topK = opts.topK ?? ENGAGEMENT_SETTINGS.retrievalTopK;
  const scope = sql`c.organization_id = ${organizationId}::uuid and c.revision_id = ${revisionId}::uuid`;
  const qe = opts.mode === "hybrid" ? opts.queryEmbedding : null;

  let order;
  let ctes = sql``;
  let joins = sql``;
  if (qe) {
    const ftsWhere = q ? sql`c.tsv @@ to_tsquery('english', ${q})` : sql`false`;
    const ftsRank = q ? sql`ts_rank_cd(c.tsv, to_tsquery('english', ${q}))` : sql`0`;
    ctes = sql`with fts as (
        select c.id, row_number() over (order by ${ftsRank} desc, c.ordinal) as r
        from retrieval_chunks c where ${scope} and ${ftsWhere}
      ), vec as (
        select c.id, row_number() over (order by c.embedding <=> ${vectorLiteral(qe.vector)}::vector, c.ordinal) as r
        from retrieval_chunks c
        where ${scope} and c.embedding is not null
          and c.embedding_model = ${qe.model} and c.embedding_dims = ${qe.dimensions}
      )`;
    joins = sql`left join fts on fts.id = c.id left join vec on vec.id = c.id`;
    const k = sql.raw(String(RRF_K));
    order = sql`coalesce(1.0 / (${k} + fts.r), 0) + coalesce(1.0 / (${k} + vec.r), 0) desc, c.ordinal`;
  } else {
    order = q ? sql`ts_rank_cd(c.tsv, to_tsquery('english', ${q})) desc, c.ordinal` : sql`c.ordinal`;
  }

  const res = await tx.execute<{
    kind: "block" | "evidence";
    block_key: string | null;
    evidence_row_id: string | null;
    evidence_key: string | null;
    evidence_title: string | null;
    evidence_excerpt: string | null;
    text: string;
  }>(sql`
    ${ctes}
    select c.kind, c.block_key, c.evidence_id as evidence_row_id, c.text,
           e.evidence_key, e.title as evidence_title, e.excerpt as evidence_excerpt
    from retrieval_chunks c
    ${joins}
    left join revision_evidence e
      on e.organization_id = c.organization_id and e.revision_id = c.revision_id and e.id = c.evidence_id
    where ${scope}
    order by ${order}
    limit ${topK}`);

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
        title: opts.titleOf?.(r.block_key) ?? "Briefing",
      });
      if (p.success) out.push({ passage: p.data, evidenceRowId: null, excerpt: null });
    }
  }
  return out;
}

/**
 * Embed a reader question for hybrid retrieval. Returns null (full-text
 * only) on any failure or timeout; Q&A never waits on, or fails because of,
 * an embedding provider. The question is sent only to a provider the
 * organization allows (the caller passes `allowedEmbeddings(...)`).
 */
export async function embedQuestion(provider: EmbeddingProvider | null, question: string): Promise<QueryEmbedding | null> {
  if (!provider) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiError("timeout", "question embedding timed out"));
      }, AI_SETTINGS.questionEmbeddingTimeoutMs);
    });
    const res = await Promise.race([
      provider.embed([question], { signal: controller.signal, timeoutMs: AI_SETTINGS.questionEmbeddingTimeoutMs }),
      timeout,
    ]);
    const vector = res.embeddings[0];
    if (!vector || vector.length !== provider.dimensions) return null;
    return { vector, model: provider.model, dimensions: provider.dimensions };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
