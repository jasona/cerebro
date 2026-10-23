import { enqueueJob, jobs, withSystemContext } from "@cerebro/database";
import { createTestWorld } from "../../../packages/domain/src/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assertWorkerDatabaseUrl, PGLITE_REFUSAL, runWorkerLoop, type LogFields } from "./worker";

describe("worker", () => {
  it("refuses to start without DATABASE_URL (PGlite)", () => {
    expect(() => assertWorkerDatabaseUrl({})).toThrow(PGLITE_REFUSAL);
    expect(assertWorkerDatabaseUrl({ DATABASE_URL: "postgres://x/y" })).toBe("postgres://x/y");
  });

  it("runs jobs, logs categories only, and stops on abort", async () => {
    const w = await createTestWorld();
    try {
      const org = w.seed.orgs.acme.id;
      const { id } = await withSystemContext(w.h.db, (tx) =>
        enqueueJob(tx, { organizationId: org, kind: "index_revision", payload: { secretText: "do not log me" } }),
      );
      const logs: { msg: string; fields?: LogFields }[] = [];
      const controller = new AbortController();
      const loop = runWorkerLoop(w.h.db, {
        signal: controller.signal,
        workerId: "test",
        intervalMs: 20,
        log: (_level, msg, fields) => {
          logs.push({ msg, ...(fields ? { fields } : {}) });
          if (msg === "job.finished") controller.abort();
        },
      });
      await loop;
      const [job] = await withSystemContext(w.h.db, (tx) => tx.select().from(jobs).where(eq(jobs.id, id!)));
      expect(job!.status).toBe("failed");
      expect(logs.map((l) => l.msg)).toEqual(["worker.started", "job.finished", "worker.stopped"]);
      expect(logs[1]!.fields).toMatchObject({ kind: "index_revision", result: "failed", errorCategory: "invalid_payload" });
      expect(JSON.stringify(logs)).not.toContain("do not log me");
    } finally {
      await w.h.close();
    }
  });
});
