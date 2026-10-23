import { enqueueJob, type Executor } from "@cerebro/database";
import { sql } from "drizzle-orm";

export const JOB_KINDS = ["index_revision", "extract_source", "summarize_topics"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** `jobs.dedupe_key` is globally unique, so every key includes the organization id. */
export const dedupeKeys = {
  indexRevision: (organizationId: string, revisionId: string) => `index_revision:${organizationId}:${revisionId}`,
  extractSource: (organizationId: string, sourceId: string, checksum: string) =>
    `extract_source:${organizationId}:${sourceId}:${checksum}`,
  summarizeTopics: (organizationId: string, revisionId: string, questionCount: number) =>
    `summarize_topics:${organizationId}:${revisionId}:${questionCount}`,
};

/**
 * Enqueue indexing for a published revision inside the caller's transaction.
 * The publication transaction does this itself; exported for re-indexing and tests.
 */
export async function enqueueIndexRevision(
  tx: Executor,
  input: { organizationId: string; briefingId: string; revisionId: string },
): Promise<{ id: string | null; created: boolean }> {
  return enqueueJob(tx, {
    organizationId: input.organizationId,
    kind: "index_revision",
    payload: { revisionId: input.revisionId, briefingId: input.briefingId },
    dedupeKey: dedupeKeys.indexRevision(input.organizationId, input.revisionId),
  });
}

/**
 * Readiness of a revision's reader retrieval projection.
 *
 * The schema has no `index_status` column, so readiness is inferred: the
 * revision is indexed when an `index_revision` job for it has succeeded AND
 * retrieval chunks exist for exactly that organization + revision. The
 * indexer replaces chunks atomically in one transaction and the job is marked
 * succeeded only after that commit, so a running or failed job (or one that
 * never ran) reads as "not indexed" and callers answer `preparing`.
 *
 * Runs under the caller's auth context; RLS scopes both tables to the org.
 */
export async function isRevisionIndexed(tx: Executor, organizationId: string, revisionId: string): Promise<boolean> {
  const res = await tx.execute<{ ready: boolean }>(sql`
    select (
      exists (
        select 1 from jobs j
        where j.organization_id = ${organizationId}::uuid
          and j.kind = 'index_revision'
          and j.status = 'succeeded'
          and j.payload->>'revisionId' = ${revisionId})
      and exists (
        select 1 from retrieval_chunks c
        where c.organization_id = ${organizationId}::uuid and c.revision_id = ${revisionId}::uuid)
    ) as ready`);
  return res.rows[0]?.ready === true;
}
