import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJobs,
  completeJob,
  createTestDatabase,
  enqueueJob,
  failJob,
  jobs,
  seedOrganizations,
  withAuthContext,
  withSystemContext,
  type DatabaseHandle,
  type SeedResult,
} from "../src/index";

let h: DatabaseHandle;
let seed: SeedResult;

beforeAll(async () => {
  h = await createTestDatabase();
  seed = await seedOrganizations(h.db);
});
afterAll(async () => {
  await h.close();
});

const acmeCtx = () => ({ userId: seed.users.riley, organizationId: seed.orgs.acme.id });

describe("job queue", () => {
  it("enqueues inside a domain transaction and dedupes", async () => {
    const first = await withAuthContext(h.db, acmeCtx(), (tx) =>
      enqueueJob(tx, { organizationId: seed.orgs.acme.id, kind: "index_revision", payload: { n: 1 }, dedupeKey: "acme:r1" }),
    );
    const second = await withAuthContext(h.db, acmeCtx(), (tx) =>
      enqueueJob(tx, { organizationId: seed.orgs.acme.id, kind: "index_revision", payload: { n: 2 }, dedupeKey: "acme:r1" }),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it("rolls back with the domain transaction", async () => {
    await expect(
      withAuthContext(h.db, acmeCtx(), async (tx) => {
        await enqueueJob(tx, { organizationId: seed.orgs.acme.id, kind: "rollback_kind" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const rows = await h.db.select().from(jobs).where(eq(jobs.kind, "rollback_kind"));
    expect(rows).toHaveLength(0);
  });

  it("cannot enqueue for another organization under an auth context", async () => {
    await expect(
      withAuthContext(h.db, acmeCtx(), (tx) => enqueueJob(tx, { organizationId: seed.orgs.globex.id, kind: "x" })),
    ).rejects.toThrow();
  });

  it("claims each job exactly once", async () => {
    await withSystemContext(h.db, async (tx) => {
      for (let i = 0; i < 5; i++) await enqueueJob(tx, { organizationId: null, kind: "claim_once" });
    });
    const results = await Promise.all([
      claimJobs(h.db, { kinds: ["claim_once"], limit: 3, workerId: "w1" }),
      claimJobs(h.db, { kinds: ["claim_once"], limit: 3, workerId: "w2" }),
      claimJobs(h.db, { kinds: ["claim_once"], limit: 3, workerId: "w3" }),
    ]);
    const ids = results.flat().map((j) => j.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(results.flat().every((j) => j.status === "running" && j.attempts === 1)).toBe(true);
    expect(await claimJobs(h.db, { kinds: ["claim_once"], limit: 10, workerId: "w4" })).toHaveLength(0);
  });

  it("does not claim future jobs and completes only when held", async () => {
    await withSystemContext(h.db, (tx) =>
      enqueueJob(tx, { organizationId: null, kind: "future", runAfter: new Date(Date.now() + 60_000) }),
    );
    expect(await claimJobs(h.db, { kinds: ["future"], limit: 5, workerId: "w" })).toHaveLength(0);

    await withSystemContext(h.db, (tx) => enqueueJob(tx, { organizationId: null, kind: "complete_me" }));
    const [job] = await claimJobs(h.db, { kinds: ["complete_me"], limit: 1, workerId: "w" });
    expect(await completeJob(h.db, job!.id, "someone-else")).toBe(false);
    expect(await completeJob(h.db, job!.id, "w")).toBe(true);
    const [row] = await h.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.status).toBe("succeeded");
  });

  it("retries with backoff, records only an error category, then fails", async () => {
    await withSystemContext(h.db, (tx) => enqueueJob(tx, { organizationId: null, kind: "flaky", maxAttempts: 2 }));
    const [job] = await claimJobs(h.db, { kinds: ["flaky"], limit: 1, workerId: "w" });
    expect(await failJob(h.db, { jobId: job!.id, workerId: "w", errorCategory: "provider_unavailable" })).toBe("retrying");
    let [row] = await h.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.status).toBe("queued");
    expect(row!.lastErrorCategory).toBe("provider_unavailable");
    expect(row!.runAfter.getTime()).toBeGreaterThan(Date.now());

    await h.db.execute(sql`update jobs set run_after = now() where id = ${job!.id}`);
    const [again] = await claimJobs(h.db, { kinds: ["flaky"], limit: 1, workerId: "w" });
    expect(again!.attempts).toBe(2);
    expect(
      await failJob(h.db, { jobId: job!.id, workerId: "w", errorCategory: "Secret payload text: do not log" }),
    ).toBe("failed");
    [row] = await h.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.status).toBe("failed");
    expect(row!.lastErrorCategory).toBe("unknown");
  });
});
