import { sql } from "drizzle-orm";
import { withSystemContext, type Database, type Executor } from "./client";
import { jobs } from "./schema";

export type Job = typeof jobs.$inferSelect;

export interface EnqueueJobInput {
  /** Must equal the transaction's app.org_id under withAuthContext; null only under withSystemContext. */
  organizationId: string | null;
  kind: string;
  payload?: Record<string, unknown>;
  /** Globally unique; include the organization id in the key. */
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Enqueue a job inside the caller's transaction, so it commits or rolls back
 * with the domain change. With a dedupe key, an existing job wins and
 * `created` is false.
 */
export async function enqueueJob(tx: Executor, input: EnqueueJobInput): Promise<{ id: string | null; created: boolean }> {
  const inserted = await tx
    .insert(jobs)
    .values({
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(sql`${jobs.dedupeKey} = ${input.dedupeKey ?? null}`);
  return { id: existing[0]?.id ?? null, created: false };
}

export interface ClaimJobsInput {
  kinds: readonly string[];
  limit: number;
  workerId: string;
  /** A running job whose lock is older than this is considered abandoned. Default 10 minutes. */
  staleAfterMs?: number;
}

/**
 * Claim up to `limit` runnable jobs with FOR UPDATE SKIP LOCKED, marking them
 * running and incrementing attempts. Runs under the system context because
 * the worker serves every organization; handlers must re-establish
 * withAuthContext for the job's organization and recheck access.
 */
export async function claimJobs(db: Database, input: ClaimJobsInput): Promise<Job[]> {
  if (input.kinds.length === 0 || input.limit <= 0) return [];
  const staleSeconds = Math.max(1, Math.round((input.staleAfterMs ?? 600_000) / 1000));
  const kinds = sql.join(
    input.kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  return withSystemContext(db, async (tx) => {
    const ids = await tx.execute<{ id: string }>(sql`
      select id from jobs
      where kind in (${kinds})
        and attempts < max_attempts
        and (
          (status = 'queued' and run_after <= now())
          or (status = 'running' and locked_at < now() - make_interval(secs => ${staleSeconds}))
        )
      order by run_after, created_at
      limit ${input.limit}
      for update skip locked`);
    if (ids.rows.length === 0) return [];
    const idList = sql.join(
      ids.rows.map((r) => sql`${r.id}::uuid`),
      sql`, `,
    );
    return tx
      .update(jobs)
      .set({
        status: "running",
        attempts: sql`${jobs.attempts} + 1`,
        lockedAt: sql`now()`,
        lockedBy: input.workerId,
        updatedAt: sql`now()`,
      })
      .where(sql`${jobs.id} in (${idList})`)
      .returning();
  });
}

/** Mark a claimed job succeeded. Returns false if the job is no longer held by this worker. */
export async function completeJob(db: Database, jobId: string, workerId: string): Promise<boolean> {
  return withSystemContext(db, async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({ status: "succeeded", lockedAt: null, lockedBy: null, lastErrorCategory: null, updatedAt: sql`now()` })
      .where(sql`${jobs.id} = ${jobId} and ${jobs.status} = 'running' and ${jobs.lockedBy} = ${workerId}`)
      .returning({ id: jobs.id });
    return rows.length > 0;
  });
}

const ERROR_CATEGORY = /^[a-z][a-z0-9_.:-]{0,63}$/;

export interface FailJobInput {
  jobId: string;
  workerId: string;
  /** Short machine category such as `provider_unavailable`. Never message or payload text. */
  errorCategory: string;
  /** False for permanent failures. Default true. */
  retryable?: boolean;
  /** Base backoff; delay is base * 2^(attempts-1), capped at one hour. Default 5s. */
  backoffBaseMs?: number;
}

/** Record a failure: requeue with exponential backoff, or fail permanently once attempts are exhausted. */
export async function failJob(db: Database, input: FailJobInput): Promise<"retrying" | "failed" | "not_held"> {
  const category = ERROR_CATEGORY.test(input.errorCategory) ? input.errorCategory : "unknown";
  const baseSeconds = (input.backoffBaseMs ?? 5_000) / 1000;
  const retryable = input.retryable ?? true;
  return withSystemContext(db, async (tx) => {
    const rows = await tx.execute<{ status: string }>(sql`
      update jobs set
        status = case when ${retryable} and attempts < max_attempts then 'queued' else 'failed' end,
        run_after = case when ${retryable} and attempts < max_attempts
          then now() + make_interval(secs => least(3600, ${baseSeconds} * power(2, greatest(attempts - 1, 0))))
          else run_after end,
        locked_at = null,
        locked_by = null,
        last_error_category = ${category},
        updated_at = now()
      where id = ${input.jobId} and status = 'running' and locked_by = ${input.workerId}
      returning status`);
    const status = rows.rows[0]?.status;
    if (!status) return "not_held";
    return status === "queued" ? "retrying" : "failed";
  });
}

/** Cancel a queued job (system context). */
export async function cancelJob(db: Database, jobId: string): Promise<boolean> {
  return withSystemContext(db, async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({ status: "cancelled", updatedAt: sql`now()` })
      .where(sql`${jobs.id} = ${jobId} and ${jobs.status} = 'queued'`)
      .returning({ id: jobs.id });
    return rows.length > 0;
  });
}
