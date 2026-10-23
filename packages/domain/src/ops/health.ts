import { timingSafeEqual } from "node:crypto";
import { loadMigrations, withSystemContext, type Database } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { invalidOpsConfig, type Env } from "./config";
import { createLogger } from "./log";

const logger = createLogger({ component: "health" });

/**
 * Readiness checks for `/api/ready` (W4 monitoring). Operational metadata
 * only: database reachability, migration state, job queue depth and age, and
 * configuration validity. No tenant content is read.
 *
 * Queue depth and age are reported, not judged: no queue-age target has been
 * agreed, so they make the service not-ready only when an operator sets
 * `READY_MAX_QUEUED_AGE_SECONDS` (off by default).
 */

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: { ok: boolean; latencyMs: number | null };
    migrations: { ok: boolean; applied: number; expected: number; pending: string[]; unknown: string[] };
    jobs: {
      ok: boolean;
      queued: number;
      running: number;
      failed: number;
      /** Age of the oldest runnable queued job, in seconds; null when none. */
      oldestQueuedSeconds: number | null;
      /** Configured threshold, or null when off. */
      maxQueuedAgeSeconds: number | null;
    };
    config: { ok: boolean; invalid: string[] };
  };
}

/** Liveness: the process is up. Never touches the database. */
export function liveness(): { status: "ok" } {
  return { status: "ok" };
}

export async function checkReadiness(db: Database, env: Env = process.env): Promise<ReadinessReport> {
  const invalid = invalidOpsConfig(env);
  const maxAgeRaw = env.READY_MAX_QUEUED_AGE_SECONDS?.trim();
  const maxQueuedAgeSeconds = maxAgeRaw && /^\d{1,9}$/.test(maxAgeRaw) ? Number(maxAgeRaw) : null;
  if (maxAgeRaw && maxAgeRaw !== "off" && maxQueuedAgeSeconds === null) invalid.push("READY_MAX_QUEUED_AGE_SECONDS");

  const report: ReadinessReport = {
    ready: false,
    checks: {
      database: { ok: false, latencyMs: null },
      migrations: { ok: false, applied: 0, expected: 0, pending: [], unknown: [] },
      jobs: { ok: false, queued: 0, running: 0, failed: 0, oldestQueuedSeconds: null, maxQueuedAgeSeconds },
      config: { ok: invalid.length === 0, invalid },
    },
  };

  try {
    const started = performance.now();
    // System context: operational counts across all organizations (no tenant
    // content); readiness has no user and must see the whole queue.
    await withSystemContext(db, async (tx) => {
      await tx.execute(sql`select 1`);
      report.checks.database = { ok: true, latencyMs: Math.round(performance.now() - started) };

      const expected = loadMigrations().map((m) => m.id);
      const applied = (await tx.execute<{ id: string }>(sql`select id from schema_migrations`)).rows.map((r) => r.id);
      const appliedSet = new Set(applied);
      const pending = expected.filter((id) => !appliedSet.has(id));
      const unknown = applied.filter((id) => !expected.includes(id));
      report.checks.migrations = { ok: pending.length === 0, applied: applied.length, expected: expected.length, pending, unknown };

      const q = await tx.execute<{ queued: number; running: number; failed: number; oldest: number | null }>(sql`
        select
          count(*) filter (where status = 'queued')::int as queued,
          count(*) filter (where status = 'running')::int as running,
          count(*) filter (where status = 'failed')::int as failed,
          extract(epoch from now() - min(run_after) filter (where status = 'queued' and run_after <= now()))::float8 as oldest
        from jobs`);
      const row = q.rows[0];
      const oldest = row?.oldest === null || row?.oldest === undefined ? null : Math.max(0, Math.floor(Number(row.oldest)));
      report.checks.jobs = {
        ok: maxQueuedAgeSeconds === null || oldest === null || oldest <= maxQueuedAgeSeconds,
        queued: Number(row?.queued ?? 0),
        running: Number(row?.running ?? 0),
        failed: Number(row?.failed ?? 0),
        oldestQueuedSeconds: oldest,
        maxQueuedAgeSeconds,
      };
    });
  } catch {
    // Database unreachable or schema missing: the failing check stays false.
  }
  const c = report.checks;
  report.ready = c.database.ok && c.migrations.ok && c.jobs.ok && c.config.ok;
  return report;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

/** `GET /api/health`: liveness only, never touches the database. */
export function healthResponse(): Response {
  return new Response(JSON.stringify(liveness()), { status: 200, headers: JSON_HEADERS });
}

/** Whether the request presents the internal readiness token (`READINESS_TOKEN`, off unless set). */
export function isInternalReadinessCaller(request: Request, env: Env = process.env): boolean {
  const token = env.READINESS_TOKEN?.trim();
  if (!token) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `GET /api/ready`: 200 when ready, 503 otherwise. Internal callers (bearer
 * `READINESS_TOKEN`) get the full report; everyone else gets the status and
 * the names of failing checks only (no counts, migration ids or config names).
 */
export async function readinessResponse(db: Database, request: Request, env: Env = process.env): Promise<Response> {
  const report = await checkReadiness(db, env);
  const status = report.ready ? 200 : 503;
  const body = isInternalReadinessCaller(request, env)
    ? { status: report.ready ? "ready" : "not_ready", ...report }
    : {
        status: report.ready ? "ready" : "not_ready",
        failing: Object.entries(report.checks)
          .filter(([, v]) => !v.ok)
          .map(([k]) => k),
      };
  if (!report.ready) {
    logger.warn("health.not_ready", {
      check: Object.entries(report.checks)
        .filter(([, v]) => !v.ok)
        .map(([k]) => k)
        .join(","),
    });
  }
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
