import { AiError } from "@cerebro/ai";
import { publications, withAuthContext, type Database, type Job, type Tx } from "@cerebro/database";
import { and, eq, sql } from "drizzle-orm";
import { canReadRevision } from "../access/index";
import { recordAudit } from "../audit";
import { AI_SETTINGS, allowedEmbeddings, getAiRuntimeOrNull, resolveOrgAiPolicy } from "../engagement/ai-runtime";
import { vectorLiteral } from "../engagement/retrieval";
import { JobError, permanent, requireJobOrg, workerContext } from "./errors";
import { RevisionJobPayload, revisionJobActors } from "./index-revision";

const RETRYABLE: ReadonlySet<string> = new Set(["unavailable", "timeout", "provider_error"]);

/**
 * Fill `retrieval_chunks.embedding` for one indexed revision (W3.2).
 *
 * Corpus: the revision's retrieval chunks only, which hold its published
 * blocks and approved evidence (principle 3). `source_chunks` are never read
 * or embedded here, and nothing private is sent to the embedding provider.
 *
 * Authorization mirrors index_revision: one narrow system lookup for the
 * acting user, then withAuthContext as that user with `canReadRevision`
 * rechecked before reading and again before writing. The embedding call runs
 * outside any transaction. The provider must still be allowed by the
 * organization's AI policy at run time.
 *
 * Failure never affects reading or full-text Q&A: the revision is already
 * indexed, and hybrid retrieval ignores chunks without a matching vector.
 */
export async function handleEmbedRevision(db: Database, job: Job): Promise<void> {
  const organizationId = requireJobOrg(job);
  const parsed = RevisionJobPayload.safeParse(job.payload);
  if (!parsed.success) throw permanent("invalid_payload");
  const { revisionId, briefingId } = parsed.data;
  const runtime = await getAiRuntimeOrNull();
  if (!runtime?.embeddings) throw permanent("embeddings_disabled");

  const actors = await revisionJobActors(db, organizationId, briefingId, revisionId);
  if (actors.length === 0) throw permanent("revision_not_found");

  const stillPublished = async (tx: Tx) => {
    const [pub] = await tx
      .select({ withdrawnAt: publications.withdrawnAt })
      .from(publications)
      .where(and(eq(publications.organizationId, organizationId), eq(publications.revisionId, revisionId)))
      .for("share");
    return !!pub && pub.withdrawnAt === null;
  };

  for (const userId of actors) {
    const ctx = workerContext(job, userId);
    const pending = await withAuthContext(db, ctx, async (tx) => {
      if (!(await canReadRevision(tx, ctx, briefingId, revisionId))) return null;
      if (!(await stillPublished(tx))) throw permanent("withdrawn");
      const provider = allowedEmbeddings(runtime, await resolveOrgAiPolicy(tx, organizationId));
      if (!provider) throw permanent("embeddings_not_allowed");
      const res = await tx.execute<{ id: string; text: string }>(sql`
        select c.id, c.text from retrieval_chunks c
        where c.organization_id = ${organizationId}::uuid and c.revision_id = ${revisionId}::uuid
          and (c.embedding is null or c.embedding_model is distinct from ${provider.model}
               or c.embedding_dims is distinct from ${provider.dimensions})
        order by c.ordinal`);
      return { provider, chunks: res.rows };
    });
    if (pending === null) continue;
    if (pending.chunks.length === 0) return;

    const { provider, chunks } = pending;
    const vectors: { id: string; text: string; vector: number[] }[] = [];
    for (let i = 0; i < chunks.length; i += AI_SETTINGS.embedBatchSize) {
      const batch = chunks.slice(i, i + AI_SETTINGS.embedBatchSize);
      let embeddings: number[][];
      try {
        ({ embeddings } = await provider.embed(
          batch.map((c) => c.text),
          { timeoutMs: AI_SETTINGS.embedTimeoutMs },
        ));
      } catch (err) {
        const category = err instanceof AiError ? err.category : "provider_error";
        throw new JobError(`embed_${category}`, RETRYABLE.has(category));
      }
      if (embeddings.length !== batch.length) throw new JobError("embed_invalid_output", false);
      batch.forEach((c, k) => {
        const v = embeddings[k]!;
        if (v.length !== provider.dimensions) throw new JobError("embed_invalid_output", false);
        vectors.push({ id: c.id, text: c.text, vector: v });
      });
    }

    const written = await withAuthContext(db, ctx, async (tx) => {
      // Recheck: access or publication may have changed during the provider call.
      if (!(await canReadRevision(tx, ctx, briefingId, revisionId))) return false;
      if (!(await stillPublished(tx))) throw permanent("withdrawn");
      let n = 0;
      for (const v of vectors) {
        // `text` guard: a chunk replaced by re-indexing is never given a stale vector.
        const res = await tx.execute(sql`
          update retrieval_chunks
          set embedding = ${vectorLiteral(v.vector)}::vector, embedding_model = ${provider.model}, embedding_dims = ${provider.dimensions}
          where organization_id = ${organizationId}::uuid and revision_id = ${revisionId}::uuid
            and id = ${v.id}::uuid and text = ${v.text}`);
        n += (res as { affectedRows?: number; rowCount?: number }).affectedRows ?? (res as { rowCount?: number }).rowCount ?? 0;
      }
      await recordAudit(tx, ctx, {
        action: "revision.embedded",
        targetType: "briefing",
        targetId: briefingId,
        revisionId,
        metadata: { chunks: n, provider: provider.id, model: provider.model, dimensions: provider.dimensions },
      });
      return true;
    });
    if (written) return;
  }
  throw permanent("forbidden");
}
