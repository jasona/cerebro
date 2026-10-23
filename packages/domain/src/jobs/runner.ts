import { randomUUID } from "node:crypto";
import { claimJobs, completeJob, failJob, type Database, type Job } from "@cerebro/database";
import { isDomainError } from "../errors";
import { JobError } from "./errors";
import { handleEmbedRevision } from "./embed-revision";
import { handleExtractSource } from "./extract-source";
import { handleIndexRevision } from "./index-revision";
import { createLogger } from "../ops/log";
import { createRetentionScheduler, handleApplyRetention } from "../ops/retention";
import { JOB_KINDS, type JobKind } from "./kinds";
import { handleSummarizeTopics } from "./summarize-topics";

const logger = createLogger({ component: "jobs" });

export type JobHandler = (db: Database, job: Job) => Promise<void>;

/**
 * Handlers by job kind. Each handler is claimed under the system context and
 * must reopen withAuthContext for the job's organization and recheck access.
 */
export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  index_revision: handleIndexRevision,
  extract_source: handleExtractSource,
  summarize_topics: handleSummarizeTopics,
  embed_revision: handleEmbedRevision,
  apply_retention: handleApplyRetention,
};

/** Structured log line for a job outcome: ids, kind, result and error category only. */
export function logJobOutcome(o: JobOutcome, workerId?: string): void {
  logger[o.result === "succeeded" ? "info" : "warn"]("job.finished", {
    jobId: o.jobId,
    kind: o.kind,
    result: o.result,
    errorCategory: o.errorCategory ?? null,
    durationMs: o.durationMs ?? null,
    workerId: workerId ?? null,
  });
}

export interface RunJobsOnceOptions {
  workerId: string;
  kinds?: readonly string[];
  limit: number;
  /** Override handlers (tests, or hosts adding kinds). Merged over JOB_HANDLERS. */
  handlers?: Partial<Record<string, JobHandler>>;
  /** Base for exponential retry backoff. Default 5 s. */
  backoffBaseMs?: number;
  staleAfterMs?: number;
}

export interface JobOutcome {
  jobId: string;
  kind: string;
  result: "succeeded" | "retrying" | "failed" | "not_held";
  /** Machine category only; never message or payload text. */
  errorCategory?: string;
  /** Handler wall time. */
  durationMs?: number;
}

export interface RunJobsOnceResult {
  claimed: number;
  outcomes: JobOutcome[];
}

const PERMANENT_DOMAIN_CODES = new Set(["not_found", "forbidden", "validation", "unauthenticated"]);

/** Map a thrown value to a safe category and retry decision. */
export function categorizeJobError(err: unknown): { category: string; retryable: boolean } {
  if (err instanceof JobError) return { category: err.category, retryable: err.retryable };
  if (isDomainError(err)) return { category: `domain_${err.code}`, retryable: !PERMANENT_DOMAIN_CODES.has(err.code) };
  return { category: "handler_error", retryable: true };
}

/**
 * Claim up to `limit` runnable jobs, run each handler, and complete or fail
 * it. Failures record an error category only; retryable failures requeue with
 * exponential backoff until max attempts.
 */
export async function runJobsOnce(db: Database, opts: RunJobsOnceOptions): Promise<RunJobsOnceResult> {
  const handlers: Partial<Record<string, JobHandler>> = { ...JOB_HANDLERS, ...opts.handlers };
  const kinds = (opts.kinds ?? [...JOB_KINDS, ...Object.keys(opts.handlers ?? {})]).filter((k) => handlers[k]);
  const jobs = await claimJobs(db, {
    kinds: [...new Set(kinds)],
    limit: opts.limit,
    workerId: opts.workerId,
    ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
  });
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    const handler = handlers[job.kind];
    const started = performance.now();
    try {
      if (!handler) throw new JobError("unknown_kind", false);
      await handler(db, job);
      const held = await completeJob(db, job.id, opts.workerId);
      outcomes.push({ jobId: job.id, kind: job.kind, result: held ? "succeeded" : "not_held", durationMs: Math.round(performance.now() - started) });
    } catch (err) {
      const { category, retryable } = categorizeJobError(err);
      const result = await failJob(db, {
        jobId: job.id,
        workerId: opts.workerId,
        errorCategory: category,
        retryable,
        ...(opts.backoffBaseMs !== undefined ? { backoffBaseMs: opts.backoffBaseMs } : {}),
      });
      outcomes.push({ jobId: job.id, kind: job.kind, result, errorCategory: category, durationMs: Math.round(performance.now() - started) });
    }
  }
  return { claimed: jobs.length, outcomes };
}

// ---------------------------------------------------------------------------
// In-process runner (web app on PGlite)
// ---------------------------------------------------------------------------

export interface InProcessJobRunner {
  readonly workerId: string;
  /** Run one pass now (skipped if a pass is already running). */
  tick(): Promise<void>;
  stop(): void;
}

export interface InProcessJobRunnerOptions {
  intervalMs: number;
  limit?: number;
  /** Called with outcomes of every non-empty pass; must not log payloads. Default: structured log line. */
  onOutcome?: (outcome: JobOutcome) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __cerebroJobRunner: InProcessJobRunner | undefined;
}

/**
 * Poll for jobs inside the current process. Intended for the web app when
 * `runJobsInProcess(handle)` is true (PGlite: one process per data dir, so a
 * separate worker cannot run). Idempotent: a singleton on globalThis, so hot
 * reloads and repeated calls return the existing runner. Passes never overlap.
 */
export function startInProcessJobRunner(db: Database, opts: InProcessJobRunnerOptions): InProcessJobRunner {
  if (globalThis.__cerebroJobRunner) return globalThis.__cerebroJobRunner;
  const workerId = `inproc:${process.pid}:${randomUUID().slice(0, 8)}`;
  let running: Promise<void> | null = null;
  let stopped = false;
  const onOutcome = opts.onOutcome ?? ((o: JobOutcome) => logJobOutcome(o, workerId));
  const retention = createRetentionScheduler();

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        await retention.tick(db);
        for (;;) {
          const res = await runJobsOnce(db, { workerId, limit: opts.limit ?? 5 });
          for (const o of res.outcomes) onOutcome(o);
          if (res.claimed === 0 || stopped) break;
        }
      } catch {
        // Claiming failed (e.g. database closing). The next interval retries.
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const timer = setInterval(() => void tick(), Math.max(50, opts.intervalMs));
  timer.unref?.();
  const runner: InProcessJobRunner = {
    workerId,
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (globalThis.__cerebroJobRunner === runner) globalThis.__cerebroJobRunner = undefined;
    },
  };
  globalThis.__cerebroJobRunner = runner;
  void tick();
  return runner;
}
