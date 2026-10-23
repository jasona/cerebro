import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  briefingRevisions,
  briefings,
  createTestDatabase,
  departments,
  integrationConnections,
  integrationOperations,
  loadMigrations,
  memberships,
  migrate,
  publications,
  seedOrganizations,
  TENANT_TABLES,
  teams,
  userIdentities,
  users,
  withAuthContext,
  withSystemContext,
  type DatabaseHandle,
  type SeedResult,
} from "../src/index";

let h: DatabaseHandle;
let seed: SeedResult;
let acme: string;
let globex: string;

/** Run `fn` and return the Postgres error it raised (walking drizzle's `cause`). */
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

async function createPublishedBriefing(orgId: string, ownerId: string) {
  return withSystemContext(h.db, async (tx) => {
    const [b] = await tx
      .insert(briefings)
      .values({ organizationId: orgId, ownerId, title: "Test", slug: `t-${randomUUID()}` })
      .returning();
    const [r] = await tx
      .insert(briefingRevisions)
      .values({
        organizationId: orgId,
        briefingId: b!.id,
        number: 1,
        documentJson: { schemaVersion: 1 },
        schemaVersion: 1,
        contentHash: "h",
        createdBy: ownerId,
      })
      .returning();
    const [p] = await tx
      .insert(publications)
      .values({ organizationId: orgId, briefingId: b!.id, revisionId: r!.id, publishedBy: ownerId })
      .returning();
    await tx.update(briefings).set({ currentPublicationId: p!.id }).where(eq(briefings.id, b!.id));
    return { briefing: b!, revision: r!, publication: p! };
  });
}

beforeAll(async () => {
  h = await createTestDatabase();
  seed = await seedOrganizations(h.db);
  acme = seed.orgs.acme.id;
  globex = seed.orgs.globex.id;
});
afterAll(async () => {
  await h.close();
});

describe("migrations", () => {
  it("run on the configured test backend", () => {
    expect(h.kind).toBe(process.env.TEST_DATABASE_URL ? "postgres" : "pglite");
  });

  it("are idempotent", async () => {
    expect(await migrate(h)).toEqual([]);
    const rows = await h.db.execute<{ id: string }>(sql`select id from schema_migrations order by id`);
    expect(rows.rows.map((r) => r.id)).toEqual(loadMigrations().map((m) => m.id));
    expect(rows.rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(["0001_extensions", "0002_schema", "0003_security", "0004_preview_base_publication", "0005_briefing_reads", "0006_identity_links", "0007_briefing_suggestions", "0008_rate_limits_ai_usage", "0009_retention"]),
    );
  });

  it("enables and forces RLS on every tenant table and on users/organizations", async () => {
    const rows = await h.db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    const byName = new Map(rows.rows.map((r) => [r.relname, r]));
    for (const table of [...TENANT_TABLES, "users", "organizations", "user_identities"]) {
      expect(byName.get(table), table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("uses a runtime role that owns nothing and cannot bypass RLS", async () => {
    const role = await h.db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = 'cerebro_app'`,
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await h.db.execute(
      sql`select 1 from pg_tables where schemaname = 'public' and tableowner = 'cerebro_app'`,
    );
    expect(owned.rows).toHaveLength(0);
  });

  it("seed is idempotent and keeps ids stable", async () => {
    const again = await seedOrganizations(h.db);
    expect(again).toEqual(seed);
  });
});

describe("tenant isolation under cerebro_app", () => {
  it("runs as cerebro_app with transaction-local settings", async () => {
    const row = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, async (tx) => {
      const r = await tx.execute<{ u: string; o: string; role: string }>(
        sql`select app_current_user()::text u, app_current_org()::text o, current_user role`,
      );
      return r.rows[0];
    });
    expect(row).toEqual({ u: seed.users.riley, o: acme, role: "cerebro_app" });
    const after = await h.db.execute<{ role: string; o: string | null }>(
      sql`select current_user role, app_current_org()::text o`,
    );
    expect(after.rows[0]).toEqual({ role: "postgres", o: null });
  });

  it("does not leak role or settings to later queries on pooled connections", async () => {
    // On Postgres these run on several pooled connections; each must return to
    // the owner role with empty app.* settings once its transaction ends.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withAuthContext(h.db, { userId: seed.users.riley, organizationId: i % 2 ? acme : globex }, (tx) =>
          tx.execute(sql`select pg_sleep(0.01)`),
        ),
      ),
    );
    await expect(
      withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, async () => {
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const rows = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.db.execute<{ role: string; u: string | null; o: string | null }>(
          sql`select current_user role, app_current_user()::text u, app_current_org()::text o, pg_sleep(0.01)::text`,
        ),
      ),
    );
    for (const r of rows) expect(r.rows[0]).toMatchObject({ role: "postgres", u: null, o: null });
  });

  it("cross-tenant select returns nothing", async () => {
    const { briefing } = await createPublishedBriefing(globex, seed.users.taylor);
    const fromAcme = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, (tx) =>
      tx.select().from(briefings).where(eq(briefings.id, briefing.id)),
    );
    expect(fromAcme).toHaveLength(0);
    const depts = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, (tx) =>
      tx.select().from(departments),
    );
    expect(depts.every((d) => d.organizationId === acme)).toBe(true);
    expect(depts).toHaveLength(4);
    const fromGlobex = await withAuthContext(h.db, { userId: seed.users.taylor, organizationId: globex }, (tx) =>
      tx.select().from(briefings).where(eq(briefings.id, briefing.id)),
    );
    expect(fromGlobex).toHaveLength(1);
  });

  it("no org context sees no tenant rows", async () => {
    const rows = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: null }, (tx) =>
      tx.select().from(departments),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects writes into another tenant (WITH CHECK)", async () => {
    const err = await pgError(() =>
      withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, (tx) =>
        tx.insert(departments).values({ organizationId: globex, name: "Evil", slug: "evil" }),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("composite FKs reject cross-tenant associations even for the owner", async () => {
    const err = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.insert(teams).values({
          organizationId: acme,
          departmentId: seed.orgs.globex.departments.operations!,
          name: "Mixed",
          slug: "mixed",
        }),
      ),
    );
    expect(err.code).toBe("23503");
  });

  it("team home must belong to the stated department", async () => {
    const err = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.insert(briefings).values({
          organizationId: acme,
          ownerId: seed.users.riley,
          title: "Wrong home",
          slug: "wrong-home",
          homeDepartmentId: seed.orgs.acme.departments.finance!,
          homeTeamId: seed.orgs.acme.teams.platform!,
        }),
      ),
    );
    expect(err.code).toBe("23503");
  });

  it("enforces home/audience CHECK rules", async () => {
    const base = { organizationId: acme, ownerId: seed.users.riley, title: "X" };
    const cases = [
      { visibility: "department", slug: "c1" },
      { visibility: "team", audienceDepartmentId: seed.orgs.acme.departments.product!, slug: "c2" },
      { visibility: "company", audienceTeamId: seed.orgs.acme.teams.platform!, slug: "c3" },
      { visibility: "public", slug: "c4" },
      { visibility: "company", homeTeamId: seed.orgs.acme.teams.platform!, slug: "c5" },
    ];
    for (const c of cases) {
      const err = await pgError(() => withSystemContext(h.db, (tx) => tx.insert(briefings).values({ ...base, ...c })));
      expect(err.code, JSON.stringify(c)).toBe("23514");
    }
  });

  it("membership rows require an org-matching user membership", async () => {
    // Casey has no Acme membership, so cannot own an Acme briefing.
    const err = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.insert(briefings).values({ organizationId: acme, ownerId: seed.users.casey, title: "X", slug: "casey" }),
      ),
    );
    expect(err.code).toBe("23503");
  });

  it("users are visible to self and to co-members only", async () => {
    const seenByRiley = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: acme }, (tx) =>
      tx.select({ id: users.id }).from(users),
    );
    const ids = seenByRiley.map((u) => u.id);
    expect(ids).toContain(seed.users.maya);
    expect(ids).not.toContain(seed.users.taylor);
    expect(ids).not.toContain(seed.users.casey);

    const caseyAlone = await withAuthContext(h.db, { userId: seed.users.casey, organizationId: null }, (tx) =>
      tx.select({ id: users.id }).from(users),
    );
    expect(caseyAlone.map((u) => u.id)).toEqual([seed.users.casey]);
  });

  it("a user sees their own memberships across companies", async () => {
    const rows = await withAuthContext(h.db, { userId: seed.users.maya, organizationId: null }, (tx) =>
      tx.select().from(memberships),
    );
    expect(rows.map((r) => r.userId)).toEqual([seed.users.maya]);
  });
});

describe("identity links and OAuth connections (0006)", () => {
  const ISSUER = "https://issuer.test";

  it("user_identities: own links only, no writes, under cerebro_app", async () => {
    await withSystemContext(h.db, (tx) =>
      tx.insert(userIdentities).values([
        { userId: seed.users.maya, issuer: ISSUER, subject: "maya-sub" },
        { userId: seed.users.riley, issuer: ISSUER, subject: "riley-sub" },
      ]),
    );
    const seenByMaya = await withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, (tx) =>
      tx.select({ subject: userIdentities.subject }).from(userIdentities),
    );
    expect(seenByMaya.map((r) => r.subject)).toEqual(["maya-sub"]);

    const insert = await pgError(() =>
      withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, (tx) =>
        tx.insert(userIdentities).values({ userId: seed.users.maya, issuer: "https://other.test", subject: "x" }),
      ),
    );
    expect(insert.code).toBe("42501");
    const update = await pgError(() =>
      withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, (tx) =>
        tx.execute(sql`update user_identities set subject = 'stolen' where subject = 'maya-sub'`),
      ),
    );
    expect(update.code).toBe("42501");
  });

  it("an (issuer, subject) links to exactly one user, and a user has one link per issuer", async () => {
    const dupSubject = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.insert(userIdentities).values({ userId: seed.users.alex, issuer: ISSUER, subject: "maya-sub" })),
    );
    expect(dupSubject.code).toBe("23505");
    const secondForIssuer = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.insert(userIdentities).values({ userId: seed.users.maya, issuer: ISSUER, subject: "maya-2" })),
    );
    expect(secondForIssuer.code).toBe("23505");
  });

  it("OAuth connections need an issuer and no token hash, and one active grant per company/user/issuer/client", async () => {
    const values = { organizationId: acme, userId: seed.users.maya, kind: "oauth", label: "OAuth", clientId: "client-a" };
    const noIssuer = await pgError(() => withSystemContext(h.db, (tx) => tx.insert(integrationConnections).values(values)));
    expect(noIssuer.code).toBe("23514");
    const withHash = await pgError(() =>
      withSystemContext(h.db, (tx) => tx.insert(integrationConnections).values({ ...values, issuer: ISSUER, tokenHash: "h" })),
    );
    expect(withHash.code).toBe("23514");

    await withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, (tx) =>
      tx.insert(integrationConnections).values({ ...values, issuer: ISSUER }),
    );
    const second = await pgError(() =>
      withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, (tx) =>
        tx.insert(integrationConnections).values({ ...values, issuer: ISSUER }),
      ),
    );
    expect(second.code).toBe("23505");
    // Once revoked, a new active grant may replace it.
    await withAuthContext(h.db, { userId: seed.users.maya, organizationId: acme }, async (tx) => {
      await tx.execute(sql`update integration_connections set status = 'revoked', revoked_at = now() where kind = 'oauth' and client_id = 'client-a'`);
      await tx.insert(integrationConnections).values({ ...values, issuer: ISSUER });
    });
    // Tenant isolation still applies: invisible from Globex.
    const fromGlobex = await withAuthContext(h.db, { userId: seed.users.taylor, organizationId: globex }, (tx) =>
      tx.select().from(integrationConnections).where(eq(integrationConnections.kind, "oauth")),
    );
    expect(fromGlobex).toHaveLength(0);
  });
});

describe("immutability", () => {
  it("denies UPDATE and DELETE of revisions to cerebro_app", async () => {
    const { revision } = await createPublishedBriefing(acme, seed.users.riley);
    const ctx = { userId: seed.users.riley, organizationId: acme };
    const upd = await pgError(() =>
      withAuthContext(h.db, ctx, (tx) =>
        tx.update(briefingRevisions).set({ contentHash: "tampered" }).where(eq(briefingRevisions.id, revision.id)),
      ),
    );
    expect(upd.code).toBe("42501");
    const del = await pgError(() =>
      withAuthContext(h.db, ctx, (tx) => tx.delete(briefingRevisions).where(eq(briefingRevisions.id, revision.id))),
    );
    expect(del.code).toBe("42501");
  });

  it("blocks revision UPDATE even for the owner connection", async () => {
    const { revision } = await createPublishedBriefing(acme, seed.users.riley);
    const err = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.update(briefingRevisions).set({ contentHash: "x" }).where(eq(briefingRevisions.id, revision.id)),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("allows only withdrawal of a publication", async () => {
    const { publication } = await createPublishedBriefing(acme, seed.users.riley);
    const ctx = { userId: seed.users.riley, organizationId: acme };
    const other = await pgError(() =>
      withAuthContext(h.db, ctx, (tx) =>
        tx.update(publications).set({ changeSummary: "rewritten" }).where(eq(publications.id, publication.id)),
      ),
    );
    expect(other.code).toBe("42501");
    await withAuthContext(h.db, ctx, (tx) =>
      tx.update(publications).set({ withdrawnAt: new Date() }).where(eq(publications.id, publication.id)),
    );
    const restore = await pgError(() =>
      withAuthContext(h.db, ctx, (tx) =>
        tx.update(publications).set({ withdrawnAt: null }).where(eq(publications.id, publication.id)),
      ),
    );
    expect(restore.code).toBe("42501");
  });

  it("allows one publication per revision and unique revision numbers", async () => {
    const { briefing, revision } = await createPublishedBriefing(acme, seed.users.riley);
    const dupPub = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.insert(publications).values({
          organizationId: acme,
          briefingId: briefing.id,
          revisionId: revision.id,
          publishedBy: seed.users.riley,
        }),
      ),
    );
    expect(dupPub.code).toBe("23505");
    const dupNum = await pgError(() =>
      withSystemContext(h.db, (tx) =>
        tx.insert(briefingRevisions).values({
          organizationId: acme,
          briefingId: briefing.id,
          number: 1,
          documentJson: {},
          schemaVersion: 1,
          contentHash: "h",
          createdBy: seed.users.riley,
        }),
      ),
    );
    expect(dupNum.code).toBe("23505");
  });
});

describe("integration operations", () => {
  it("idempotency keys are unique per org/actor/connection/action, including null connections", async () => {
    const ctx = { userId: seed.users.riley, organizationId: acme };
    const row = {
      organizationId: acme,
      actorId: seed.users.riley,
      action: "create_brief_draft",
      idempotencyKey: "k1",
      inputDigest: "d",
    };
    await withAuthContext(h.db, ctx, (tx) => tx.insert(integrationOperations).values(row));
    const err = await pgError(() => withAuthContext(h.db, ctx, (tx) => tx.insert(integrationOperations).values(row)));
    expect(err.code).toBe("23505");
    await withAuthContext(h.db, ctx, (tx) =>
      tx.insert(integrationOperations).values({ ...row, action: "publish_brief" }),
    );
  });
});
