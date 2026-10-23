import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiRuns, enqueueJob, organizations, rateLimitCounters, withAuthContext, withSystemContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRevisionDocument } from "../briefings/index";
import { askQuestion, requestTopicSummary } from "../engagement/index";
import { drainJobs, makePublishedBriefing } from "../engagement/test-fixtures";
import { DomainError } from "../errors";
import { runJobsOnce } from "../jobs/runner";
import { addSource, LocalSourceStore, setSourceStore } from "../sources/index";
import { createTestWorld, type TestWorld } from "../testing";
import { getAiUsageSummary } from "./ai-usage";
import { invalidOpsConfig, parseWindowLimit } from "./config";
import { checkReadiness, healthResponse, readinessResponse } from "./health";
import { createLogger, REDACTED, setLogSink, type LogRecord } from "./log";
import { enforceRateLimit } from "./rate-limit";

let w: TestWorld;
let objects: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-ops-"));
  setSourceStore(new LocalSourceStore(objects));
});
afterEach(async () => {
  process.env = { ...savedEnv };
  setLogSink(undefined);
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

/** Capture structured log lines for the duration of a test. */
function captureLogs(): LogRecord[] {
  const lines: LogRecord[] = [];
  process.env.LOG_LEVEL = "debug";
  setLogSink((r) => lines.push(r));
  return lines;
}

const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
const NRR = "What net revenue retention did mid-market accounts record?";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

describe("structured logger", () => {
  it("emits allowlisted fields and redacts everything else", () => {
    const lines = captureLogs();
    createLogger({ component: "test" }).info("unit.event", {
      jobId: "j-1",
      latencyMs: 12,
      question: "secret question text",
      prompt: "secret prompt",
      kind: "index_revision",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", event: "unit.event", component: "test", jobId: "j-1", latencyMs: 12, kind: "index_revision" });
    expect(lines[0]!.question).toBe(REDACTED);
    expect(lines[0]!.prompt).toBe(REDACTED);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("rejects free-text event names, respects the level and never throws from the sink", () => {
    const lines = captureLogs();
    const log = createLogger();
    log.info("Reader asked: what is the budget?");
    expect(lines[0]!.event).toBe("log.invalid_event");
    process.env.LOG_LEVEL = "warn";
    log.info("unit.quiet");
    expect(lines).toHaveLength(1);
    setLogSink(() => {
      throw new Error("sink down");
    });
    expect(() => log.error("unit.loud")).not.toThrow();
  });

  it("logs AI runs with counts and categories, never question text", async () => {
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    const lines = captureLogs();
    const SECRET = "Is the Halcyon reorganisation confidential?";
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: SECRET });
    const run = lines.find((l) => l.event === "ai.run");
    expect(run).toMatchObject({ component: "ai", task: "answer", provider: "deterministic", organizationId: fb.organizationId });
    expect(typeof run!.latencyMs).toBe("number");
    expect(JSON.stringify(lines)).not.toContain("Halcyon");
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("limit configuration", () => {
  it("is off unless set, and reports unparseable values", () => {
    expect(parseWindowLimit(undefined)).toBeNull();
    expect(parseWindowLimit("off")).toBeNull();
    expect(parseWindowLimit(" 10 / 60 ")).toEqual({ max: 10, windowSeconds: 60 });
    expect(parseWindowLimit("ten per minute")).toEqual({ error: expect.any(String) });
    expect(parseWindowLimit("5/0")).toEqual({ error: expect.any(String) });
    expect(invalidOpsConfig({})).toEqual([]);
    expect(invalidOpsConfig({ RATE_LIMIT_QA_PER_USER: "lots", AI_USAGE_LIMIT_TOKENS: "1000/3600" })).toEqual(["RATE_LIMIT_QA_PER_USER"]);
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe("rate limits", () => {
  it("are off by default and write nothing", async () => {
    for (let i = 0; i < 5; i++) await enforceRateLimit(w.h.db, w.ctx("alex"), "qa", { env: {} });
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(rateLimitCounters));
    expect(rows).toEqual([]);
  });

  it("limit each user separately and return a retry-after", async () => {
    const env = { RATE_LIMIT_QA_PER_USER: "2/3600" };
    await enforceRateLimit(w.h.db, w.ctx("alex"), "qa", { env });
    await enforceRateLimit(w.h.db, w.ctx("alex"), "qa", { env });
    const err = await enforceRateLimit(w.h.db, w.ctx("alex"), "qa", { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("rate_limited");
    const retry = (err as DomainError).details!.retryAfterSeconds as number;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(3600);
    // Another user, and another operation, are unaffected.
    await enforceRateLimit(w.h.db, w.ctx("priya"), "qa", { env });
    await enforceRateLimit(w.h.db, w.ctx("alex"), "upload", { env });
  });

  it("limit each connection separately from the user", async () => {
    const env = { RATE_LIMIT_MCP_TOOL_PER_CONNECTION: "1/3600" };
    const a = { ...w.ctx("maya", "acme", "mcp"), connectionId: "00000000-0000-4000-8000-00000000000a" };
    const b = { ...w.ctx("maya", "acme", "mcp"), connectionId: "00000000-0000-4000-8000-00000000000b" };
    await enforceRateLimit(w.h.db, a, "mcp_tool", { env });
    await expect(enforceRateLimit(w.h.db, a, "mcp_tool", { env })).rejects.toSatisfy(code("rate_limited"));
    await enforceRateLimit(w.h.db, b, "mcp_tool", { env });
    // Web calls have no connection, so the per-connection limit does not apply.
    await enforceRateLimit(w.h.db, w.ctx("maya"), "mcp_tool", { env });
    await enforceRateLimit(w.h.db, w.ctx("maya"), "mcp_tool", { env });
  });

  it("reset with the window and keep only the current window's row", async () => {
    const env = { RATE_LIMIT_UPLOAD_PER_USER: "1/2" };
    // Start just after a window boundary so both calls land in the same 2-second window.
    await new Promise((r) => setTimeout(r, 2000 - (Date.now() % 2000) + 20));
    await enforceRateLimit(w.h.db, w.ctx("alex"), "upload", { env });
    await expect(enforceRateLimit(w.h.db, w.ctx("alex"), "upload", { env })).rejects.toSatisfy(code("rate_limited"));
    await new Promise((r) => setTimeout(r, 2100));
    await enforceRateLimit(w.h.db, w.ctx("alex"), "upload", { env });
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(rateLimitCounters));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucket: "upload:user", count: 1 });
  });

  it("counters are private to their user under the runtime role", async () => {
    const env = { RATE_LIMIT_QA_PER_USER: "5/3600" };
    await enforceRateLimit(w.h.db, w.ctx("alex"), "qa", { env });
    const seen = async (user: "alex" | "maya" | "riley") =>
      withAuthContext(w.h.db, w.ctx(user), (tx) => tx.select().from(rateLimitCounters));
    expect(await seen("alex")).toHaveLength(1);
    expect(await seen("maya")).toEqual([]);
    expect(await seen("riley")).toEqual([]);
  });

  it("apply to reader Q&A and uploads through the domain services", async () => {
    process.env.RATE_LIMIT_QA_PER_USER = "1/3600";
    process.env.RATE_LIMIT_UPLOAD_PER_USER = "1/3600";
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR });
    await expect(askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR })).rejects.toSatisfy(code("rate_limited"));
    await addSource(w.h.db, w.ctx("maya"), { kind: "text", text: "First note.", origin: "manual" });
    await expect(addSource(w.h.db, w.ctx("maya"), { kind: "text", text: "Second note.", origin: "manual" })).rejects.toSatisfy(code("rate_limited"));
  });
});

// ---------------------------------------------------------------------------
// AI usage and cost controls
// ---------------------------------------------------------------------------

describe("AI usage", () => {
  it("records per-organization runs without content, summarised for owners/admins only", async () => {
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR });
    await askQuestion(w.h.db, w.ctx("priya"), { briefingId: fb.id, question: NRR });
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(aiRuns));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ organizationId: fb.organizationId, task: "answer", provider: "deterministic" });
    expect(JSON.stringify(rows)).not.toContain("net revenue");

    const summary = await getAiUsageSummary(w.h.db, w.ctx("riley"), { windowSeconds: 3600 }, {});
    expect(summary.rows).toEqual([expect.objectContaining({ task: "answer", provider: "deterministic", runs: 2, failed: 0 })]);
    expect(summary.rows[0]!.latencyP95Ms).not.toBeNull();
    expect(summary.limits).toEqual({ runs: null, tokens: null });
    await expect(getAiUsageSummary(w.h.db, w.ctx("maya"), { windowSeconds: 3600 })).rejects.toSatisfy(code("forbidden"));
    const globex = await getAiUsageSummary(w.h.db, w.ctx("taylor", "globex"), { windowSeconds: 3600 });
    expect(globex.rows).toEqual([]);
  });

  it("degrade Q&A gracefully at an organization's run limit while reading continues", async () => {
    process.env.AI_USAGE_LIMIT_RUNS = "1/3600";
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    const first = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR });
    expect(first.status).toBe("answered");
    const second = await askQuestion(w.h.db, w.ctx("priya"), { briefingId: fb.id, question: NRR });
    expect(second.status).toBe("failed");
    expect(second.missing).toMatch(/unavailable/i);
    const runs = await withSystemContext(w.h.db, (tx) => tx.select().from(aiRuns).orderBy(aiRuns.createdAt));
    expect(runs.map((r) => [r.provider, r.errorCategory])).toEqual([
      ["deterministic", null],
      ["none", "usage_limited"],
    ]);
    // Reading never depends on AI.
    const doc = await getRevisionDocument(w.h.db, w.ctx("priya"), { briefingId: fb.id });
    expect(doc.revision.revisionNumber).toBe(1);
    // Limited runs never reached a provider and do not count; Globex is unaffected by Acme's usage.
    const other = await makePublishedBriefing(w, { org: "globex", owner: "taylor" });
    await drainJobs(w);
    expect((await askQuestion(w.h.db, w.ctx("taylor", "globex"), { briefingId: other.id, question: NRR })).status).toBe("answered");
  });

  it("an organization's own setting overrides the process default", async () => {
    process.env.AI_USAGE_LIMIT_RUNS = "1/3600";
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    await withSystemContext(w.h.db, (tx) =>
      tx.update(organizations).set({ settings: { ai: { usageLimits: { runs: "off" } } } }).where(eq(organizations.id, fb.organizationId)),
    );
    for (const u of ["alex", "priya", "jordan"] as const) {
      expect((await askQuestion(w.h.db, w.ctx(u), { briefingId: fb.id, question: NRR })).status).toBe("answered");
    }
    await withSystemContext(w.h.db, (tx) =>
      tx.update(organizations).set({ settings: { ai: { usageLimits: { tokens: "0/3600" } } } }).where(eq(organizations.id, fb.organizationId)),
    );
    expect((await askQuestion(w.h.db, w.ctx("sam"), { briefingId: fb.id, question: NRR })).status).toBe("failed");
  });

  it("topic summaries retry later instead of calling the provider over the limit", async () => {
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR });
    process.env.AI_USAGE_LIMIT_RUNS = "1/3600";
    await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id);
    const res = await runJobsOnce(w.h.db, { workerId: "t", limit: 5, kinds: ["summarize_topics"] });
    expect(res.outcomes).toEqual([expect.objectContaining({ result: "retrying", errorCategory: "ai_usage_limited" })]);
  });
});

// ---------------------------------------------------------------------------
// Health and readiness
// ---------------------------------------------------------------------------

describe("health and readiness", () => {
  it("liveness never needs the database", async () => {
    const res = healthResponse();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("is ready on a migrated database and reports the job queue", async () => {
    await withSystemContext(w.h.db, (tx) =>
      enqueueJob(tx, { organizationId: w.seed.orgs.acme.id, kind: "index_revision", payload: {}, runAfter: new Date(Date.now() - 120_000) }),
    );
    const r = await checkReadiness(w.h.db, {});
    expect(r.ready).toBe(true);
    expect(r.checks.database.ok).toBe(true);
    expect(r.checks.migrations).toMatchObject({ ok: true, pending: [] });
    expect(r.checks.jobs).toMatchObject({ ok: true, queued: 1, maxQueuedAgeSeconds: null });
    expect(r.checks.jobs.oldestQueuedSeconds).toBeGreaterThanOrEqual(119);
    // Queue age only matters once an operator sets a threshold.
    const strict = await checkReadiness(w.h.db, { READY_MAX_QUEUED_AGE_SECONDS: "60" });
    expect(strict.ready).toBe(false);
    expect(strict.checks.jobs.ok).toBe(false);
  });

  it("is not ready with pending migrations or invalid limit configuration", async () => {
    expect((await checkReadiness(w.h.db, { RATE_LIMIT_QA_PER_USER: "fast" })).checks.config).toEqual({ ok: false, invalid: ["RATE_LIMIT_QA_PER_USER"] });
    await withSystemContext(w.h.db, (tx) => tx.execute(sql`delete from schema_migrations where id = '0009_retention'`));
    const r = await checkReadiness(w.h.db, {});
    expect(r.ready).toBe(false);
    expect(r.checks.migrations.pending).toEqual(["0009_retention"]);
  });

  it("returns details only to internal callers", async () => {
    const env = { READINESS_TOKEN: "internal-probe-token-123" };
    const anon = await readinessResponse(w.h.db, new Request("http://x/api/ready"), env);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ status: "ready", failing: [] });
    const wrong = await readinessResponse(w.h.db, new Request("http://x/api/ready", { headers: { authorization: "Bearer nope" } }), env);
    expect(Object.keys(await wrong.json())).toEqual(["status", "failing"]);
    const internal = await readinessResponse(
      w.h.db,
      new Request("http://x/api/ready", { headers: { authorization: `Bearer ${env.READINESS_TOKEN}` } }),
      env,
    );
    const body = (await internal.json()) as { status: string; checks: { jobs: unknown } };
    expect(body.status).toBe("ready");
    expect(body.checks.jobs).toBeDefined();

    const broken = await readinessResponse(w.h.db, new Request("http://x/api/ready"), { RATE_LIMIT_QA_PER_USER: "fast" });
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({ status: "not_ready", failing: ["config"] });
  });
});
