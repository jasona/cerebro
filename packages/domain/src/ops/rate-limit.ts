import { withAuthContext, type Database } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { rateLimitFor, type Env, type RateLimitOperation, type RateLimitScope, type WindowLimit } from "./config";
import { createLogger } from "./log";

const logger = createLogger({ component: "rate_limit" });

export interface RateLimitDecision {
  allowed: boolean;
  scope: RateLimitScope;
  count: number;
  limit: number;
  windowSeconds: number;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

/** Details carried by a `rate_limited` DomainError (safe to return to the caller). */
export interface RateLimitedDetails {
  retryAfterSeconds: number;
  scope: RateLimitScope;
  operation: RateLimitOperation;
}

/**
 * Enforce the configured per-user and per-connection limits for one
 * operation, counting this call. Throws `rate_limited` with
 * `{ retryAfterSeconds }` when any limit is exceeded.
 *
 * Limits are off unless configured (see ops/config.ts); with none set this
 * returns without touching the database. Counters are fixed windows aligned
 * to the database clock and stored in `rate_limit_counters`, so every process
 * sharing the database shares the limits (PGlite included, within its one
 * process). The counter is consumed in its own short transaction before the
 * operation runs, so rejected or failing calls still count.
 */
export async function enforceRateLimit(
  db: Database,
  ctx: RequestContext,
  operation: RateLimitOperation,
  opts: { env?: Env } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const checks: { scope: RateLimitScope; bucket: string; limit: WindowLimit }[] = [];
  const perUser = rateLimitFor(operation, "user", env);
  if (perUser) checks.push({ scope: "user", bucket: `${operation}:user`, limit: perUser });
  const perConnection = ctx.connectionId ? rateLimitFor(operation, "connection", env) : null;
  if (perConnection && ctx.connectionId) {
    checks.push({ scope: "connection", bucket: `${operation}:connection:${ctx.connectionId.toLowerCase()}`, limit: perConnection });
  }
  if (!checks.length) return;

  const c = RequestContext.parse(ctx);
  const decisions = await withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    const out: RateLimitDecision[] = [];
    for (const check of checks) {
      const w = check.limit.windowSeconds;
      const windowStart = sql`to_timestamp(floor(extract(epoch from now()) / ${w}::int) * ${w}::int)`;
      const res = await tx.execute<{ count: number; retry: number }>(sql`
        insert into rate_limit_counters (organization_id, user_id, bucket, window_start, count)
        values (${c.organizationId}::uuid, ${c.userId}::uuid, ${check.bucket}, ${windowStart}, 1)
        on conflict (organization_id, user_id, bucket, window_start)
        do update set count = rate_limit_counters.count + 1, updated_at = now()
        returning count,
          greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => ${w}::int)) - now())))::int as retry`);
      // Earlier windows of this bucket are spent; keep the table small.
      await tx.execute(sql`
        delete from rate_limit_counters
        where organization_id = ${c.organizationId}::uuid and user_id = ${c.userId}::uuid
          and bucket = ${check.bucket} and window_start < ${windowStart}`);
      const row = res.rows[0]!;
      const count = Number(row.count);
      out.push({
        allowed: count <= check.limit.max,
        scope: check.scope,
        count,
        limit: check.limit.max,
        windowSeconds: w,
        retryAfterSeconds: Number(row.retry),
      });
    }
    return out;
  });

  const denied = decisions.filter((d) => !d.allowed);
  if (!denied.length) return;
  const worst = denied.reduce((a, b) => (b.retryAfterSeconds > a.retryAfterSeconds ? b : a));
  logger.warn("rate_limit.exceeded", {
    organizationId: c.organizationId,
    userId: c.userId,
    connectionId: c.connectionId ?? null,
    via: c.via,
    kind: operation,
    scope: worst.scope,
    limit: worst.limit,
    windowSeconds: worst.windowSeconds,
    retryAfterSeconds: worst.retryAfterSeconds,
  });
  const details: RateLimitedDetails = { retryAfterSeconds: worst.retryAfterSeconds, scope: worst.scope, operation };
  throw new DomainError("rate_limited", `Too many requests. Try again in ${worst.retryAfterSeconds} seconds.`, { ...details });
}

/** `retryAfterSeconds` from a `rate_limited` DomainError's details, if present. */
export function retryAfterSeconds(details: unknown): number | undefined {
  const v = (details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}
