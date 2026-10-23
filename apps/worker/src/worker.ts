import { hostname } from "node:os";
import type { Database } from "@cerebro/database";
import { runJobsOnce, type JobOutcome } from "@cerebro/domain";

export type LogLevel = "info" | "warn" | "error";
/** Structured log fields: ids, kinds, counts and categories only — never payload or source text. */
export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (level: LogLevel, msg: string, fields?: LogFields) => void;

export const jsonLogger: Logger = (level, msg, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

export const PGLITE_REFUSAL =
  "The worker requires DATABASE_URL (PostgreSQL). PGlite allows only one process per data directory, " +
  "so under PGlite the web app runs background jobs in-process instead. Set DATABASE_URL to run a separate worker.";

/** Throws unless a Postgres URL is configured. Checked before any database is opened. */
export function assertWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error(PGLITE_REFUSAL);
  return url;
}

export const defaultWorkerId = () => `worker:${hostname()}:${process.pid}`;

export interface WorkerLoopOptions {
  signal: AbortSignal;
  workerId?: string;
  intervalMs?: number;
  batchSize?: number;
  log?: Logger;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const outcomeFields = (o: JobOutcome): LogFields => ({
  jobId: o.jobId,
  kind: o.kind,
  result: o.result,
  errorCategory: o.errorCategory ?? null,
});

/**
 * Poll-and-run loop. Drains available jobs, then sleeps `intervalMs`. Stops
 * after the in-flight batch finishes once `signal` aborts (graceful SIGTERM).
 */
export async function runWorkerLoop(db: Database, opts: WorkerLoopOptions): Promise<void> {
  const log = opts.log ?? jsonLogger;
  const workerId = opts.workerId ?? defaultWorkerId();
  const intervalMs = opts.intervalMs ?? 1_000;
  log("info", "worker.started", { workerId, intervalMs });
  while (!opts.signal.aborted) {
    let claimed = 0;
    try {
      const res = await runJobsOnce(db, { workerId, limit: opts.batchSize ?? 5 });
      claimed = res.claimed;
      for (const o of res.outcomes) log(o.result === "succeeded" ? "info" : "warn", "job.finished", outcomeFields(o));
    } catch (err) {
      log("error", "worker.poll_failed", { workerId, errorName: err instanceof Error ? err.name : "unknown" });
    }
    if (claimed === 0) await sleep(intervalMs, opts.signal);
  }
  log("info", "worker.stopped", { workerId });
}
