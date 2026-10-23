import { briefings, briefingRevisions, withSystemContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { getDraft, getRevisionDocument, listRevisions } from "../briefings/index";
import { createTestWorld, type TestWorld } from "../testing";
import { seedBriefings } from "./index";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

const countBriefings = (orgId: string) =>
  withSystemContext(w.h.db, async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(briefings).where(eq(briefings.organizationId, orgId));
    return r!.n;
  });

describe("seedBriefings", () => {
  it("seeds through the services and is safe to run twice", async () => {
    await seedBriefings(w.h, w.seed);
    const acme = await countBriefings(w.seed.orgs.acme.id);
    const globex = await countBriefings(w.seed.orgs.globex.id);
    expect(acme).toBe(8);
    expect(globex).toBe(1);
    await seedBriefings(w.h, w.seed);
    expect(await countBriefings(w.seed.orgs.acme.id)).toBe(acme);
    expect(await countBriefings(w.seed.orgs.globex.id)).toBe(globex);
    const revs = await withSystemContext(w.h.db, (tx) => tx.select().from(briefingRevisions));
    expect(revs.length).toBe(9);

    const [strategy] = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(briefings).where(eq(briefings.slug, "our-next-chapter-a-focused-move-upmarket")),
    );
    const history = await listRevisions(w.h.db, w.ctx("alex"), strategy!.id);
    expect(history.map((r) => r.revisionNumber)).toEqual([2, 1]);
    // Casey: external grant reads, never drafts.
    const doc = await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: strategy!.id });
    expect(doc.revision.revisionNumber).toBe(2);
    expect(doc.evidence.length).toBeGreaterThan(0);
    await expect(getDraft(w.h.db, w.ctx("casey"), strategy!.id)).rejects.toBeInstanceOf(DomainError);
    // Team audience: Priya (Product dept, not Platform) cannot read the Platform plan.
    const [plan] = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(briefings).where(eq(briefings.slug, "platform-readiness-for-the-mid-market-pilot")),
    );
    await expect(getRevisionDocument(w.h.db, w.ctx("priya"), { briefingId: plan!.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: plan!.id })).revision.revisionNumber).toBe(1);
  });
});
