import { aiRuns, organizations, withAuthContext, type Database, type Executor } from "@cerebro/database";
import type { AiRunRecord } from "@cerebro/ai";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getMembership } from "../access/index";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { aiUsageLimitFor, parseWindowLimit, type AiUsageMeasure, type Env, type WindowLimit } from "./config";
import { createLogger } from "./log";

const logger = createLogger({ component: "ai" });

/**
 * Per-organization AI usage (W4 cost controls).
 *
 * Usage is recorded in `ai_runs`, one row per task run: task, provider,
 * model, prompt version, status, latency, and token counts when the provider
 * reports them. Never prompts, questions, passages or outputs.
 *
 * Limits are optional and off by default: a process-wide default from
 * `AI_USAGE_LIMIT_RUNS` / `AI_USAGE_LIMIT_TOKENS`, which an organization's
 * `settings.ai.usageLimits.{runs,tokens}` may override with its own
 * `<max>/<windowSeconds>` or `"off"`. When a limit is reached, AI features
 * degrade the same way as a provider outage (principle 6): Q&A answers
 * "unavailable" while reading continues, and topic summaries retry later.
 * Runs that never reached a provider (provider `none`) do not count.
 */

/** Persist an AI run record (ids, labels, counts and categories only) and log it. */
export async function recordAiRun(tx: Executor, organizationId: string, actorId: string, record: AiRunRecord): Promise<string> {
  const status = record.status === "failed" ? "failed" : record.outcome && record.outcome !== "answered" ? "abstained" : "succeeded";
  const [row] = await tx
    .insert(aiRuns)
    .values({
      organizationId,
      actorId,
      task: record.task,
      provider: record.provider,
      model: record.model,
      promptVersion: record.promptVersion,
      status,
      latencyMs: record.latencyMs,
      inputTokens: record.usage.inputTokens ?? null,
      outputTokens: record.usage.outputTokens ?? null,
      errorCategory: record.errorCategory,
      completedAt: sql`now()`,
    })
    .returning({ id: aiRuns.id });
  logger[status === "failed" ? "warn" : "info"]("ai.run", {
    organizationId,
    task: record.task,
    provider: record.provider,
    model: record.model,
    promptVersion: record.promptVersion,
    status,
    latencyMs: record.latencyMs,
    inputTokens: record.usage.inputTokens ?? null,
    outputTokens: record.usage.outputTokens ?? null,
    cacheReadInputTokens: record.usage.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: record.usage.cacheWriteInputTokens ?? null,
    errorCategory: record.errorCategory,
  });
  return row!.id;
}

export interface AiUsageLimits {
  runs: WindowLimit | null;
  tokens: WindowLimit | null;
}

/** Effective limits for an organization: its own settings override the process default. */
export async function resolveAiUsageLimits(tx: Executor, organizationId: string, env: Env = process.env): Promise<AiUsageLimits> {
  const [row] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  const own = (row?.settings as { ai?: { usageLimits?: Partial<Record<AiUsageMeasure, unknown>> } } | null | undefined)?.ai?.usageLimits;
  const pick = (m: AiUsageMeasure): WindowLimit | null => {
    const v = own?.[m];
    if (typeof v === "string") {
      const parsed = parseWindowLimit(v);
      // A malformed organization override falls back to the process default.
      if (parsed === null) return null;
      if (!("error" in parsed)) return parsed;
    }
    return aiUsageLimitFor(m, env);
  };
  return { runs: pick("runs"), tokens: pick("tokens") };
}

export type AiUsageCheck = { allowed: true } | { allowed: false; measure: AiUsageMeasure; limit: WindowLimit };

/** Whether the organization may start another AI run under its limits. */
export async function checkAiUsage(tx: Executor, organizationId: string, env: Env = process.env): Promise<AiUsageCheck> {
  const limits = await resolveAiUsageLimits(tx, organizationId, env);
  for (const measure of ["runs", "tokens"] as const) {
    const limit = limits[measure];
    if (!limit) continue;
    const res = await tx.execute<{ runs: number; tokens: number }>(sql`
      select count(*)::int as runs,
        coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::float8 as tokens
      from ai_runs
      where organization_id = ${organizationId}::uuid and provider <> 'none'
        and created_at > now() - make_interval(secs => ${limit.windowSeconds}::int)`);
    const used = Number(res.rows[0]?.[measure] ?? 0);
    if (used >= limit.max) {
      logger.warn("ai.usage_limited", { organizationId, category: measure, limit: limit.max, windowSeconds: limit.windowSeconds });
      return { allowed: false, measure, limit };
    }
  }
  return { allowed: true };
}

export interface AiUsageRow {
  task: string;
  provider: string;
  model: string;
  runs: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface AiUsageSummaryDto {
  windowSeconds: number;
  rows: AiUsageRow[];
  limits: AiUsageLimits;
}

/**
 * Usage per task/provider/model over a window, for company owners and admins.
 * Counts and latencies only. Requires an active owner/admin membership.
 */
export async function getAiUsageSummary(
  db: Database,
  ctx: RequestContext,
  raw: { windowSeconds: number },
  env: Env = process.env,
): Promise<AiUsageSummaryDto> {
  const c = RequestContext.parse(ctx);
  const { windowSeconds } = z.object({ windowSeconds: z.number().int().positive().max(10 * 366 * 86_400) }).parse(raw);
  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    const m = await getMembership(tx, c);
    if (!m || (m.role !== "owner" && m.role !== "admin")) throw new DomainError("forbidden", "Only company owners and admins can see AI usage.");
    const res = await tx.execute<{
      task: string;
      provider: string;
      model: string;
      runs: number;
      failed: number;
      input_tokens: number;
      output_tokens: number;
      p50: number | null;
      p95: number | null;
    }>(sql`
      select task, provider, model,
        count(*)::int as runs,
        count(*) filter (where status = 'failed')::int as failed,
        coalesce(sum(input_tokens), 0)::float8 as input_tokens,
        coalesce(sum(output_tokens), 0)::float8 as output_tokens,
        percentile_cont(0.5) within group (order by latency_ms)::float8 as p50,
        percentile_cont(0.95) within group (order by latency_ms)::float8 as p95
      from ai_runs
      where organization_id = ${c.organizationId}::uuid
        and created_at > now() - make_interval(secs => ${windowSeconds}::int)
      group by task, provider, model
      order by task, provider, model`);
    return {
      windowSeconds,
      rows: res.rows.map((r) => ({
        task: r.task,
        provider: r.provider,
        model: r.model,
        runs: Number(r.runs),
        failed: Number(r.failed),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        latencyP50Ms: r.p50 === null ? null : Math.round(Number(r.p50)),
        latencyP95Ms: r.p95 === null ? null : Math.round(Number(r.p95)),
      })),
      limits: await resolveAiUsageLimits(tx, c.organizationId, env),
    };
  });
}
