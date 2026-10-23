import { enqueueJob, jobs, retrievalChunks, withSystemContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainJobs, makePublishedBriefing } from "../engagement/test-fixtures";
import { createTestWorld, type TestWorld } from "../testing";
import { JobError } from "./errors";
import { isRevisionIndexed } from "./kinds";
import { runJobsOnce, startInProcessJobRunner } from "./runner";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  globalThis.__cerebroJobRunner?.stop();
  await w.h.close();
});

const getJob = (id: string) => withSystemContext(w.h.db, async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);

describe("runJobsOnce", () => {
  it("claims a job once and retries with backoff", async () => {
    const org = w.seed.orgs.acme.id;
    const { id } = await withSystemContext(w.h.db, (tx) =>
      enqueueJob(tx, { organizationId: org, kind: "test_flaky", dedupeKey: `test_flaky:${org}:1`, maxAttempts: 3 }),
    );
    let calls = 0;
    const handlers = {
      test_flaky: async () => {
        calls++;
        if (calls === 1) throw new JobError("provider_unavailable", true);
      },
    };
    const [a, b] = await Promise.all([
      runJobsOnce(w.h.db, { workerId: "w1", limit: 5, kinds: ["test_flaky"], handlers, backoffBaseMs: 60_000 }),
      runJobsOnce(w.h.db, { workerId: "w2", limit: 5, kinds: ["test_flaky"], handlers, backoffBaseMs: 60_000 }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(calls).toBe(1);
    const outcome = [...a.outcomes, ...b.outcomes][0]!;
    expect(outcome).toMatchObject({ result: "retrying", errorCategory: "provider_unavailable" });

    let job = await getJob(id!);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.lastErrorCategory).toBe("provider_unavailable");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not runnable before the backoff elapses.
    expect((await runJobsOnce(w.h.db, { workerId: "w1", limit: 5, kinds: ["test_flaky"], handlers })).claimed).toBe(0);
    await withSystemContext(w.h.db, (tx) => tx.update(jobs).set({ runAfter: sql`now()` }).where(eq(jobs.id, id!)));
    const again = await runJobsOnce(w.h.db, { workerId: "w1", limit: 5, kinds: ["test_flaky"], handlers });
    expect(again.outcomes[0]).toMatchObject({ result: "succeeded" });
    job = await getJob(id!);
    expect(job).toMatchObject({ status: "succeeded", attempts: 2, lastErrorCategory: null });
  });

  it("fails permanently on non-retryable errors and records only a category", async () => {
    const org = w.seed.orgs.acme.id;
    const { id } = await withSystemContext(w.h.db, (tx) => enqueueJob(tx, { organizationId: org, kind: "test_bad" }));
    const res = await runJobsOnce(w.h.db, {
      workerId: "w1",
      limit: 1,
      handlers: {
        test_bad: async () => {
          throw new Error("secret source text must never be stored");
        },
      },
      kinds: ["test_bad"],
    });
    expect(res.outcomes[0]).toMatchObject({ result: "retrying", errorCategory: "handler_error" });
    expect(JSON.stringify(await getJob(id!))).not.toContain("secret source text");

    const { id: id2 } = await withSystemContext(w.h.db, (tx) => enqueueJob(tx, { organizationId: org, kind: "index_revision", payload: { nope: 1 } }));
    const res2 = await runJobsOnce(w.h.db, { workerId: "w1", limit: 5, kinds: ["index_revision"] });
    expect(res2.outcomes.find((o) => o.jobId === id2)).toMatchObject({ result: "failed", errorCategory: "invalid_payload" });
  });
});

describe("index_revision", () => {
  it("builds the projection from published blocks and approved evidence, keyed by org + revision", async () => {
    const fb = await makePublishedBriefing(w);
    const rev = fb.revisions[0]!;
    const ready = () => withSystemContext(w.h.db, (tx) => isRevisionIndexed(tx, fb.organizationId, rev.id));
    expect(await ready()).toBe(false);
    await drainJobs(w);
    expect(await ready()).toBe(true);
    const chunks = await withSystemContext(w.h.db, (tx) => tx.select().from(retrievalChunks).where(eq(retrievalChunks.revisionId, rev.id)));
    expect(chunks.every((c) => c.organizationId === fb.organizationId)).toBe(true);
    expect(chunks.filter((c) => c.kind === "evidence")).toHaveLength(4);
    expect(chunks.some((c) => c.blockKey === "blk_rec_decision")).toBe(true);
    expect(chunks.some((c) => c.blockKey === "position")).toBe(true);
  });
});

describe("startInProcessJobRunner", () => {
  it("is a singleton and processes queued jobs", async () => {
    const fb = await makePublishedBriefing(w);
    const r1 = startInProcessJobRunner(w.h.db, { intervalMs: 50 });
    const r2 = startInProcessJobRunner(w.h.db, { intervalMs: 50 });
    expect(r2).toBe(r1);
    await r1.tick();
    await r1.tick();
    expect(await withSystemContext(w.h.db, (tx) => isRevisionIndexed(tx, fb.organizationId, fb.revisions[0]!.id))).toBe(true);
    r1.stop();
    expect(globalThis.__cerebroJobRunner).toBeUndefined();
  });
});
