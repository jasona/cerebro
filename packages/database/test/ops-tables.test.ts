/**
 * Runtime-role (cerebro_app) behavior of the tables added by migrations 0007
 * (briefing_suggestions), 0008 (rate_limit_counters) and 0009
 * (retention_policies, source deletion and the narrowed revision_evidence
 * immutability guard).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  briefingRevisions,
  briefings,
  briefingSuggestions,
  createTestDatabase,
  rateLimitCounters,
  retentionPolicies,
  revisionEvidence,
  seedOrganizations,
  sources,
  withAuthContext,
  withSystemContext,
  type DatabaseHandle,
  type SeedResult,
} from "../src/index";

let h: DatabaseHandle;
let seed: SeedResult;
let acme: string;
let globex: string;

async function pgError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    let e = err as { code?: string; message: string; cause?: unknown };
    while (!e.code && e.cause) e = e.cause as typeof e;
    return e;
  }
  throw new Error("expected an error");
}

const as = (user: keyof SeedResult["users"], org = acme) => ({ userId: seed.users[user], organizationId: org });

beforeAll(async () => {
  h = await createTestDatabase();
  seed = await seedOrganizations(h.db);
  acme = seed.orgs.acme.id;
  globex = seed.orgs.globex.id;
});
afterAll(async () => {
  await h.close();
});

describe("rate_limit_counters", () => {
  const row = (userId: string, organizationId = acme) => ({
    organizationId,
    userId,
    bucket: "qa:user",
    windowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000),
    count: 1,
  });

  it("are visible and writable only by their own user", async () => {
    await withAuthContext(h.db, as("alex"), (tx) => tx.insert(rateLimitCounters).values(row(seed.users.alex)));
    const own = await withAuthContext(h.db, as("alex"), (tx) => tx.select().from(rateLimitCounters));
    expect(own).toHaveLength(1);
    // Co-members and owners see nothing.
    expect(await withAuthContext(h.db, as("riley"), (tx) => tx.select().from(rateLimitCounters))).toEqual([]);
    // Writing a row for someone else fails the policy check.
    const forged = await pgError(() => withAuthContext(h.db, as("riley"), (tx) => tx.insert(rateLimitCounters).values(row(seed.users.alex))));
    expect(forged.code).toBe("42501");
    // Or for another company.
    const cross = await pgError(() => withAuthContext(h.db, as("alex"), (tx) => tx.insert(rateLimitCounters).values(row(seed.users.alex, globex))));
    expect(cross.code).toBe("42501");
  });

  it("reject malformed bucket labels (no free text)", async () => {
    const err = await pgError(() =>
      withAuthContext(h.db, as("alex"), (tx) => tx.insert(rateLimitCounters).values({ ...row(seed.users.alex), bucket: "what is the budget?" })),
    );
    expect(err.code).toBe("23514");
  });
});

describe("briefing_suggestions", () => {
  async function briefingIn(organizationId: string, ownerId: string) {
    const [b] = await withSystemContext(h.db, (tx) =>
      tx.insert(briefings).values({ organizationId, ownerId, title: "Suggestions", slug: `s-${randomUUID()}` }).returning(),
    );
    return b!.id;
  }
  const suggestion = (organizationId: string, briefingId: string, createdBy: string) => ({
    organizationId,
    briefingId,
    kind: "perspective" as const,
    baseVersion: 1,
    payload: { perspective: { label: "Finance" }, rationale: "r" },
    provider: "deterministic",
    model: "deterministic-v1",
    createdBy,
  });

  it("are tenant-isolated, and the briefing must belong to the same company", async () => {
    const briefingId = await briefingIn(acme, seed.users.maya);
    const [row] = await withAuthContext(h.db, as("maya"), (tx) =>
      tx.insert(briefingSuggestions).values(suggestion(acme, briefingId, seed.users.maya)).returning(),
    );
    expect(await withAuthContext(h.db, as("taylor", globex), (tx) => tx.select().from(briefingSuggestions).where(eq(briefingSuggestions.id, row!.id)))).toEqual([]);
    const cross = await pgError(() =>
      withAuthContext(h.db, as("taylor", globex), (tx) => tx.insert(briefingSuggestions).values(suggestion(acme, briefingId, seed.users.taylor))),
    );
    expect(cross.code).toBe("42501");
    // Composite tenant FK: a globex suggestion cannot point at an acme briefing, even for the owner.
    const fk = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.insert(briefingSuggestions).values(suggestion(globex, briefingId, seed.users.taylor))),
    );
    expect(fk.code).toBe("23503");
    // Cross-tenant updates touch nothing.
    await withAuthContext(h.db, as("taylor", globex), (tx) =>
      tx.update(briefingSuggestions).set({ status: "dismissed", decidedAt: new Date() }).where(eq(briefingSuggestions.id, row!.id)),
    );
    const [still] = await withSystemContext(h.db, (tx) => tx.select().from(briefingSuggestions).where(eq(briefingSuggestions.id, row!.id)));
    expect(still!.status).toBe("pending");
  });

  it("only the decision columns are writable, rows are never deleted, and a decided suggestion is final", async () => {
    const briefingId = await briefingIn(acme, seed.users.maya);
    const [row] = await withAuthContext(h.db, as("maya"), (tx) =>
      tx.insert(briefingSuggestions).values(suggestion(acme, briefingId, seed.users.maya)).returning(),
    );
    const id = row!.id;
    const payload = await pgError(() =>
      withAuthContext(h.db, as("maya"), (tx) => tx.update(briefingSuggestions).set({ payload: { tampered: true } }).where(eq(briefingSuggestions.id, id))),
    );
    expect(payload.code).toBe("42501");
    const base = await pgError(() =>
      withAuthContext(h.db, as("maya"), (tx) => tx.update(briefingSuggestions).set({ baseVersion: 99 }).where(eq(briefingSuggestions.id, id))),
    );
    expect(base.code).toBe("42501");
    const del = await pgError(() => withAuthContext(h.db, as("maya"), (tx) => tx.delete(briefingSuggestions).where(eq(briefingSuggestions.id, id))));
    expect(del.code).toBe("42501");

    await withAuthContext(h.db, as("maya"), (tx) =>
      tx.update(briefingSuggestions).set({ status: "dismissed", decidedBy: seed.users.maya, decidedAt: new Date() }).where(eq(briefingSuggestions.id, id)),
    );
    const reopen = await pgError(() =>
      withAuthContext(h.db, as("maya"), (tx) =>
        tx.update(briefingSuggestions).set({ status: "pending", decidedBy: null, decidedAt: null }).where(eq(briefingSuggestions.id, id)),
      ),
    );
    expect(reopen.code).toBe("42501");
    // Final for the owner connection too.
    const owner = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.update(briefingSuggestions).set({ status: "accepted", appliedVersion: 2 }).where(eq(briefingSuggestions.id, id))),
    );
    expect(owner.code).toBe("42501");
  });
});

describe("retention_policies", () => {
  it("are tenant-isolated and cannot be deleted by the runtime role", async () => {
    await withAuthContext(h.db, as("riley"), (tx) =>
      tx.insert(retentionPolicies).values({ organizationId: acme, category: "events", retainDays: 30, updatedBy: seed.users.riley }),
    );
    expect(await withAuthContext(h.db, as("taylor", globex), (tx) => tx.select().from(retentionPolicies))).toEqual([]);
    const del = await pgError(() => withAuthContext(h.db, as("riley"), (tx) => tx.delete(retentionPolicies)));
    expect(del.code).toBe("42501");
    const bad = await pgError(() =>
      withAuthContext(h.db, as("riley"), (tx) =>
        tx.insert(retentionPolicies).values({ organizationId: acme, category: "audit", retainDays: 1, updatedBy: seed.users.riley }),
      ),
    );
    expect(bad.code).toBe("23514");
  });
});

describe("source deletion vs immutable published evidence", () => {
  async function publishedEvidenceFromSource() {
    return withSystemContext(h.db, async (tx) => {
      const [src] = await tx
        .insert(sources)
        .values({ organizationId: acme, createdBy: seed.users.maya, kind: "text", title: "Memo", textContent: "Memo text", checksum: "sha256:x" })
        .returning();
      const [b] = await tx.insert(briefings).values({ organizationId: acme, ownerId: seed.users.maya, title: "T", slug: `t-${randomUUID()}` }).returning();
      const [r] = await tx
        .insert(briefingRevisions)
        .values({ organizationId: acme, briefingId: b!.id, number: 1, documentJson: { schemaVersion: 1 }, schemaVersion: 1, contentHash: "h", createdBy: seed.users.maya })
        .returning();
      const [ev] = await tx
        .insert(revisionEvidence)
        .values({ organizationId: acme, revisionId: r!.id, evidenceKey: "ev_memo", title: "Memo", excerpt: "Approved excerpt", sourceId: src!.id, excerptHash: "h" })
        .returning();
      return { source: src!, evidence: ev! };
    });
  }

  it("deleting a source clears only the provenance link, even under the runtime role", async () => {
    const { source, evidence } = await publishedEvidenceFromSource();
    await withAuthContext(h.db, as("maya"), (tx) => tx.delete(sources).where(eq(sources.id, source.id)));
    const [after] = await withSystemContext(h.db, (tx) => tx.select().from(revisionEvidence).where(eq(revisionEvidence.id, evidence.id)));
    expect(after).toMatchObject({ sourceId: null, excerpt: "Approved excerpt", title: "Memo", evidenceKey: "ev_memo" });
  });

  it("any other change to published evidence is still refused, for every role", async () => {
    const { evidence } = await publishedEvidenceFromSource();
    const owner = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.update(revisionEvidence).set({ excerpt: "Tampered" }).where(eq(revisionEvidence.id, evidence.id))),
    );
    expect(owner.code).toBe("42501");
    // Clearing source_id together with another column is also refused.
    const mixed = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.update(revisionEvidence).set({ sourceId: null, title: "Renamed" }).where(eq(revisionEvidence.id, evidence.id)),
      ),
    );
    expect(mixed.code).toBe("42501");
    const runtime = await pgError(() =>
      withAuthContext(h.db, as("maya"), (tx) => tx.update(revisionEvidence).set({ sourceId: null }).where(eq(revisionEvidence.id, evidence.id))),
    );
    expect(runtime.code).toBe("42501");
  });

  it("the runtime role cannot delete another company's sources", async () => {
    const { source } = await publishedEvidenceFromSource();
    await withAuthContext(h.db, as("taylor", globex), (tx) => tx.delete(sources).where(eq(sources.id, source.id)));
    const still = await withSystemContext(h.db, (tx) => tx.select().from(sources).where(eq(sources.id, source.id)));
    expect(still).toHaveLength(1);
  });
});
