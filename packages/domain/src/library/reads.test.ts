import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { briefingReads, withAuthContext, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEngagementSummary } from "../engagement/index";
import { makePublishedBriefing, publishRevision } from "../engagement/test-fixtures";
import { createTestWorld, type TestWorld } from "../testing";
import { getMyBriefingRead, listLibrary, recordBriefingRead } from "./index";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  await w.h.close();
});

const rowFor = async (user: "alex" | "maya", briefingId: string) =>
  (await listLibrary(w.h.db, w.ctx(user), { scope: { kind: "company" } })).items.find((r) => r.briefingId === briefingId)!;

describe("briefing_reads (private per-user reading state)", () => {
  it("drives Unread / New version for the reader only", async () => {
    const fb = await makePublishedBriefing(w, { owner: "maya" });
    expect(await rowFor("alex", fb.id)).toMatchObject({ isUnread: true, hasNewVersion: false });
    // The author's own brief is never "unread" for them.
    expect(await rowFor("maya", fb.id)).toMatchObject({ isUnread: false, hasNewVersion: false });

    expect(await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1 })).toBe(true);
    expect(await rowFor("alex", fb.id)).toMatchObject({ isUnread: false, hasNewVersion: false });

    await publishRevision(w, fb);
    expect(await rowFor("alex", fb.id)).toMatchObject({ isUnread: false, hasNewVersion: true, revisionNumber: 2 });

    await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 2 });
    // Opening an older pinned version never moves the record backwards.
    await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1 });
    expect((await getMyBriefingRead(w.h.db, w.ctx("alex"), fb.id))?.lastRevisionNumber).toBe(2);
    expect(await rowFor("alex", fb.id)).toMatchObject({ isUnread: false, hasNewVersion: false });
  });

  it("records nothing without read access", async () => {
    const fb = await makePublishedBriefing(w, { owner: "maya", visibility: "restricted" });
    expect(await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1 })).toBe(false);
    expect(await recordBriefingRead(w.h.db, w.ctx("taylor", "globex"), { briefingId: fb.id, revisionNumber: 1 })).toBe(false);
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(briefingReads).where(eq(briefingReads.briefingId, fb.id)));
    expect(rows).toHaveLength(0);
  });

  it("the author (or an admin) cannot read other users' rows, even with direct SQL under the runtime role", async () => {
    const fb = await makePublishedBriefing(w, { owner: "maya" });
    await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1 });
    await recordBriefingRead(w.h.db, w.ctx("sam"), { briefingId: fb.id, revisionNumber: 1 });

    for (const user of ["maya", "riley"] as const) {
      const visible = await withAuthContext(w.h.db, { userId: w.seed.users[user], organizationId: fb.organizationId }, (tx) =>
        tx.select().from(briefingReads).where(eq(briefingReads.briefingId, fb.id)),
      );
      expect(visible, user).toHaveLength(0);
      expect(await getMyBriefingRead(w.h.db, w.ctx(user), fb.id)).toBeNull();
    }
    // A user sees exactly their own row.
    const own = await withAuthContext(w.h.db, { userId: w.seed.users.alex, organizationId: fb.organizationId }, (tx) =>
      tx.select().from(briefingReads),
    );
    expect(own.map((r) => r.userId)).toEqual([w.seed.users.alex]);

    // Nor can anyone write a row for someone else.
    await expect(
      withAuthContext(w.h.db, { userId: w.seed.users.maya, organizationId: fb.organizationId }, (tx) =>
        tx.insert(briefingReads).values({ organizationId: fb.organizationId, briefingId: fb.id, userId: w.seed.users.alex, lastRevisionNumber: 1 }),
      ),
    ).rejects.toThrow();
  });

  it("engagement summaries do not use reading state", async () => {
    const fb = await makePublishedBriefing(w, { owner: "maya" });
    const before = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    await recordBriefingRead(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1 });
    await recordBriefingRead(w.h.db, w.ctx("sam"), { briefingId: fb.id, revisionNumber: 1 });
    const after = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(after).toEqual(before);

    // And no engagement (author analytics) code references the table.
    const dir = join(import.meta.dirname, "..", "engagement");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && statSync(join(dir, f)).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(/briefing_reads|briefingReads/.test(text), f).toBe(false);
    }
  });
});
