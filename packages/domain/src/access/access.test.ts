import { randomUUID } from "node:crypto";
import {
  briefingGrants,
  briefingRevisions,
  briefings,
  createTestDatabase,
  departmentMemberships,
  memberships,
  publications,
  seedOrganizations,
  teamMemberships,
  withAuthContext,
  withSystemContext,
  type DatabaseHandle,
  type GrantRole,
  type SeedResult,
  type SeedUserKey,
  type Visibility,
} from "@cerebro/database";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import {
  assertBriefingCapability,
  canReadRevision,
  CAPABILITIES,
  getBriefingCapabilities,
  getMembership,
  readablePublishedBriefingsCondition,
  requireCompanyRole,
  type Capability,
} from "./index";

let h: DatabaseHandle;
let seed: SeedResult;

beforeEach(async () => {
  h = await createTestDatabase();
  seed = await seedOrganizations(h.db);
  return () => h.close();
});

const ctx = (user: SeedUserKey, org: "acme" | "globex" = "acme"): RequestContext => ({
  userId: seed.users[user],
  organizationId: seed.orgs[org].id,
  via: "web",
  requestId: randomUUID(),
});

const as = <T>(user: SeedUserKey, fn: (tx: Parameters<Parameters<typeof withAuthContext>[2]>[0], c: RequestContext) => Promise<T>, org: "acme" | "globex" = "acme") => {
  const c = ctx(user, org);
  return withAuthContext(h.db, c, (tx) => fn(tx, c));
};

const caps = (user: SeedUserKey, briefingId: string, org: "acme" | "globex" = "acme") =>
  as(user, (tx, c) => getBriefingCapabilities(tx, c, briefingId), org);

const sorted = (s: Set<Capability>) => [...s].sort();
const READ: Capability[] = ["read", "view_evidence"];

interface BriefingSpec {
  owner?: SeedUserKey;
  visibility?: Visibility;
  audienceDepartment?: string;
  audienceTeam?: string;
  homeDepartment?: string;
  homeTeam?: string;
  /** Number of published revisions (0 = draft only). The last one is current. */
  revisions?: number;
}

async function makeBriefing(spec: BriefingSpec = {}) {
  const acme = seed.orgs.acme;
  const organizationId = acme.id;
  const ownerId = seed.users[spec.owner ?? "maya"];
  return withSystemContext(h.db, async (tx) => {
    const [b] = await tx
      .insert(briefings)
      .values({
        organizationId,
        ownerId,
        title: "Fixture",
        slug: `b-${randomUUID()}`,
        visibility: spec.visibility ?? "company",
        audienceDepartmentId: spec.audienceDepartment ? acme.departments[spec.audienceDepartment] : null,
        audienceTeamId: spec.audienceTeam ? acme.teams[spec.audienceTeam] : null,
        homeDepartmentId: spec.homeDepartment ? acme.departments[spec.homeDepartment] : null,
        homeTeamId: spec.homeTeam ? acme.teams[spec.homeTeam] : null,
      })
      .returning();
    const revisionIds: string[] = [];
    const publicationIds: string[] = [];
    for (let n = 1; n <= (spec.revisions ?? 1); n++) {
      const [r] = await tx
        .insert(briefingRevisions)
        .values({
          organizationId,
          briefingId: b!.id,
          number: n,
          documentJson: { schemaVersion: 1 },
          schemaVersion: 1,
          contentHash: `h${n}`,
          createdBy: ownerId,
        })
        .returning();
      const [p] = await tx
        .insert(publications)
        .values({ organizationId, briefingId: b!.id, revisionId: r!.id, publishedBy: ownerId })
        .returning();
      revisionIds.push(r!.id);
      publicationIds.push(p!.id);
    }
    const current = publicationIds.at(-1) ?? null;
    if (current) await tx.update(briefings).set({ currentPublicationId: current }).where(eq(briefings.id, b!.id));
    return { id: b!.id, revisionIds, publicationIds };
  });
}

async function grant(briefingId: string, user: SeedUserKey, role: GrantRole, revisionId?: string) {
  const [g] = await withSystemContext(h.db, (tx) =>
    tx
      .insert(briefingGrants)
      .values({
        organizationId: seed.orgs.acme.id,
        briefingId,
        userId: seed.users[user],
        role,
        revisionId: revisionId ?? null,
        issuedBy: seed.users.maya,
      })
      .returning(),
  );
  return g!;
}

const system = <T>(fn: Parameters<typeof withSystemContext<T>>[1]) => withSystemContext(h.db, fn);

async function expectDomainError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

describe("company membership", () => {
  it("returns the active membership and role", async () => {
    expect(await as("riley", (tx, c) => getMembership(tx, c))).toMatchObject({ role: "owner" });
    expect(await as("maya", (tx, c) => getMembership(tx, c))).toMatchObject({ role: "member" });
    expect(await as("casey", (tx, c) => getMembership(tx, c))).toBeNull();
    expect(await as("taylor", (tx, c) => getMembership(tx, c))).toBeNull();
  });

  it("requireCompanyRole allows listed roles and forbids others", async () => {
    await as("riley", (tx, c) => requireCompanyRole(tx, c, ["owner", "admin"]));
    await expectDomainError(as("maya", (tx, c) => requireCompanyRole(tx, c, ["owner", "admin"])), "forbidden");
    await expectDomainError(as("casey", (tx, c) => requireCompanyRole(tx, c, ["member"])), "forbidden");
  });

  it("ignores removed memberships", async () => {
    await system((tx) =>
      tx.update(memberships).set({ status: "removed" }).where(eq(memberships.userId, seed.users.maya)),
    );
    expect(await as("maya", (tx, c) => getMembership(tx, c))).toBeNull();
  });
});

describe("briefing roles (content capability matrix)", () => {
  it("grants exactly the matrix capabilities per briefing role", async () => {
    const b = await makeBriefing({ owner: "maya", visibility: "restricted" });
    await grant(b.id, "sam", "editor");
    await grant(b.id, "jordan", "publisher");
    await grant(b.id, "alex", "owner");
    await grant(b.id, "priya", "reader");

    expect(sorted(await caps("maya", b.id))).toEqual([...CAPABILITIES].sort());
    expect(sorted(await caps("alex", b.id))).toEqual([...CAPABILITIES].sort());
    expect(sorted(await caps("sam", b.id))).toEqual(["edit", "read", "view_draft", "view_engagement", "view_evidence"]);
    expect(sorted(await caps("jordan", b.id))).toEqual([
      "publish",
      "read",
      "view_draft",
      "view_engagement",
      "view_evidence",
      "withdraw",
    ]);
    expect(sorted(await caps("priya", b.id))).toEqual(READ);
    expect(sorted(await caps("riley", b.id))).toEqual([]);
  });

  it("an editor plus publisher holds the union", async () => {
    const b = await makeBriefing({ visibility: "restricted" });
    await grant(b.id, "sam", "editor");
    await grant(b.id, "sam", "publisher");
    expect(sorted(await caps("sam", b.id))).toEqual([
      "edit",
      "publish",
      "read",
      "view_draft",
      "view_engagement",
      "view_evidence",
      "withdraw",
    ]);
  });

  it("assertBriefingCapability: not_found without read, forbidden without the capability", async () => {
    const b = await makeBriefing({ visibility: "restricted" });
    await grant(b.id, "priya", "reader");
    await expectDomainError(as("riley", (tx, c) => assertBriefingCapability(tx, c, b.id, "read")), "not_found");
    await expectDomainError(as("priya", (tx, c) => assertBriefingCapability(tx, c, b.id, "edit")), "forbidden");
    await expectDomainError(as("priya", (tx, c) => assertBriefingCapability(tx, c, b.id, "view_draft")), "forbidden");
    await as("priya", (tx, c) => assertBriefingCapability(tx, c, b.id, "view_evidence"));
    await as("maya", (tx, c) => assertBriefingCapability(tx, c, b.id, "manage_access"));
    await expectDomainError(
      as("maya", (tx, c) => assertBriefingCapability(tx, c, randomUUID(), "read")),
      "not_found",
    );
    await expectDomainError(as("maya", (tx, c) => assertBriefingCapability(tx, c, "not-a-uuid", "read")), "not_found");
  });

  it("revoked grants confer nothing", async () => {
    const b = await makeBriefing({ visibility: "restricted" });
    const g = await grant(b.id, "sam", "editor");
    expect((await caps("sam", b.id)).has("edit")).toBe(true);
    await system((tx) => tx.update(briefingGrants).set({ revokedAt: new Date() }).where(eq(briefingGrants.id, g.id)));
    expect(sorted(await caps("sam", b.id))).toEqual([]);
  });

  it("editor, publisher and owner roles require active company membership", async () => {
    const b = await makeBriefing({ owner: "maya", visibility: "restricted" });
    await grant(b.id, "sam", "editor");
    await grant(b.id, "casey", "publisher"); // external: ignored
    expect(sorted(await caps("casey", b.id))).toEqual([]);
    await system((tx) =>
      tx.update(memberships).set({ status: "removed" }).where(inArray(memberships.userId, [seed.users.sam, seed.users.maya])),
    );
    expect(sorted(await caps("sam", b.id))).toEqual([]);
    expect(sorted(await caps("maya", b.id))).toEqual([]);
  });
});

describe("drafts", () => {
  it("drafts are visible only to collaborators; readers never get drafts", async () => {
    const draft = await makeBriefing({ owner: "maya", visibility: "company", revisions: 0 });
    await grant(draft.id, "priya", "reader");
    await grant(draft.id, "sam", "editor");
    expect(sorted(await caps("maya", draft.id))).toEqual([...CAPABILITIES].sort());
    expect((await caps("sam", draft.id)).has("view_draft")).toBe(true);
    expect(sorted(await caps("priya", draft.id))).toEqual([]);
    expect(sorted(await caps("jordan", draft.id))).toEqual([]);
    expect(sorted(await caps("riley", draft.id))).toEqual([]);

    const published = await makeBriefing({ owner: "maya", visibility: "company" });
    for (const user of ["riley", "priya", "jordan", "alex", "sam"] as const) {
      expect(sorted(await caps(user, published.id)), user).toEqual(READ);
    }
  });
});

describe("derived audiences", () => {
  it("company visibility requires active company membership", async () => {
    const b = await makeBriefing({ visibility: "company" });
    expect(sorted(await caps("jordan", b.id))).toEqual(READ);
    expect(sorted(await caps("casey", b.id))).toEqual([]);
    await system((tx) => tx.update(memberships).set({ status: "suspended" }).where(eq(memberships.userId, seed.users.jordan)));
    expect(sorted(await caps("jordan", b.id))).toEqual([]);
  });

  it("team audience: team members only; parent-department-only membership is not enough", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "team", audienceTeam: "platform" });
    expect(sorted(await caps("maya", b.id))).toEqual(READ);
    expect(sorted(await caps("alex", b.id))).toEqual(READ);
    // Priya is an explicit Product department member but not in Platform.
    expect(sorted(await caps("priya", b.id))).toEqual([]);
    expect(sorted(await caps("jordan", b.id))).toEqual([]);
  });

  it("department audience: explicit department members and members of its teams", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "department", audienceDepartment: "product" });
    expect(sorted(await caps("priya", b.id))).toEqual(READ); // explicit department membership
    expect(sorted(await caps("maya", b.id))).toEqual(READ); // via Platform/Experience
    expect(sorted(await caps("alex", b.id))).toEqual(READ); // via Platform (also in Engineering)
    expect(sorted(await caps("jordan", b.id))).toEqual([]);
    expect(sorted(await caps("sam", b.id))).toEqual([]);
  });

  it("revoked team or department membership loses derived access; company access remains", async () => {
    const team = await makeBriefing({ owner: "riley", visibility: "team", audienceTeam: "platform" });
    const dept = await makeBriefing({ owner: "riley", visibility: "department", audienceDepartment: "product" });
    const company = await makeBriefing({ owner: "riley", visibility: "company" });
    await system(async (tx) => {
      await tx
        .update(teamMemberships)
        .set({ status: "removed" })
        .where(eq(teamMemberships.userId, seed.users.alex));
      await tx
        .update(departmentMemberships)
        .set({ status: "removed" })
        .where(eq(departmentMemberships.userId, seed.users.priya));
    });
    expect(sorted(await caps("alex", team.id))).toEqual([]);
    expect(sorted(await caps("alex", dept.id))).toEqual([]);
    expect(sorted(await caps("priya", dept.id))).toEqual([]);
    expect(sorted(await caps("alex", company.id))).toEqual(READ);
  });

  it("removed company membership invalidates team access even with active team membership", async () => {
    const team = await makeBriefing({ owner: "riley", visibility: "team", audienceTeam: "platform" });
    await system((tx) => tx.update(memberships).set({ status: "removed" }).where(eq(memberships.userId, seed.users.maya)));
    expect(sorted(await caps("maya", team.id))).toEqual([]);
  });

  it("moving a briefing's home does not change its audience", async () => {
    const b = await makeBriefing({
      owner: "riley",
      visibility: "team",
      audienceTeam: "platform",
      homeDepartment: "product",
      homeTeam: "platform",
    });
    const before = { maya: sorted(await caps("maya", b.id)), priya: sorted(await caps("priya", b.id)) };
    await system((tx) =>
      tx
        .update(briefings)
        .set({ homeDepartmentId: seed.orgs.acme.departments.finance!, homeTeamId: seed.orgs.acme.teams.planning! })
        .where(eq(briefings.id, b.id)),
    );
    expect({ maya: sorted(await caps("maya", b.id)), priya: sorted(await caps("priya", b.id)) }).toEqual(before);
    expect(before).toEqual({ maya: READ, priya: [] });
  });

  it("restricted visibility requires a grant", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "restricted" });
    for (const user of ["maya", "alex", "priya", "jordan", "sam"] as const) {
      expect(sorted(await caps(user, b.id)), user).toEqual([]);
    }
    await grant(b.id, "jordan", "reader");
    expect(sorted(await caps("jordan", b.id))).toEqual(READ);
  });
});

describe("company admins and owners", () => {
  it("have no implicit content capabilities", async () => {
    await system((tx) =>
      tx.update(memberships).set({ role: "admin" }).where(eq(memberships.userId, seed.users.sam)),
    );
    const restricted = await makeBriefing({ owner: "maya", visibility: "restricted" });
    const teamOnly = await makeBriefing({ owner: "maya", visibility: "team", audienceTeam: "platform" });
    const draft = await makeBriefing({ owner: "maya", revisions: 0 });
    const company = await makeBriefing({ owner: "maya", visibility: "company" });
    for (const admin of ["riley", "sam"] as const) {
      expect(sorted(await caps(admin, restricted.id)), admin).toEqual([]);
      expect(sorted(await caps(admin, teamOnly.id)), admin).toEqual([]);
      expect(sorted(await caps(admin, draft.id)), admin).toEqual([]);
      expect(sorted(await caps(admin, company.id)), admin).toEqual(READ);
    }
  });
});

describe("external readers", () => {
  it("a grant lets an external user read published content but never drafts", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "restricted" });
    await grant(b.id, "casey", "reader");
    expect(sorted(await caps("casey", b.id))).toEqual(READ);
    await expectDomainError(as("casey", (tx, c) => assertBriefingCapability(tx, c, b.id, "view_draft")), "forbidden");
    expect(await as("casey", (tx, c) => getMembership(tx, c))).toBeNull();
  });

  it("a grant does not expose other company briefings", async () => {
    const granted = await makeBriefing({ owner: "riley", visibility: "restricted" });
    const company = await makeBriefing({ owner: "riley", visibility: "company" });
    await grant(granted.id, "casey", "reader");
    expect(sorted(await caps("casey", company.id))).toEqual([]);
    const readable = await as("casey", (tx, c) =>
      tx.select({ id: briefings.id }).from(briefings).where(readablePublishedBriefingsCondition(c)),
    );
    expect(readable.map((r) => r.id)).toEqual([granted.id]);
  });

  it("another company's user gets nothing, even with a guessed id", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "company" });
    expect(sorted(await caps("taylor", b.id, "globex"))).toEqual([]);
    expect(sorted(await caps("taylor", b.id, "acme"))).toEqual([]);
  });
});

describe("withdrawal and revisions", () => {
  it("a withdrawn current publication is unreadable to readers but still visible to collaborators", async () => {
    const b = await makeBriefing({ owner: "maya", visibility: "company" });
    await system((tx) =>
      tx.update(publications).set({ withdrawnAt: new Date() }).where(eq(publications.id, b.publicationIds[0]!)),
    );
    expect(sorted(await caps("jordan", b.id))).toEqual([]);
    expect((await caps("maya", b.id)).has("view_draft")).toBe(true);
    expect(await as("jordan", (tx, c) => canReadRevision(tx, c, b.id, b.revisionIds[0]!))).toBe(false);
    expect(await as("maya", (tx, c) => canReadRevision(tx, c, b.id, b.revisionIds[0]!))).toBe(true);
  });

  it("revision-scoped grants cover only their revision", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "restricted", revisions: 2 });
    const [r1, r2] = b.revisionIds as [string, string];
    await grant(b.id, "casey", "reader", r1);
    expect(await as("casey", (tx, c) => canReadRevision(tx, c, b.id, r1))).toBe(true);
    expect(await as("casey", (tx, c) => canReadRevision(tx, c, b.id, r2))).toBe(false);
    // The current publication is r2, so briefing-level read is not granted.
    expect(sorted(await caps("casey", b.id))).toEqual([]);

    await grant(b.id, "priya", "reader");
    expect(await as("priya", (tx, c) => canReadRevision(tx, c, b.id, r1))).toBe(true);
    expect(await as("priya", (tx, c) => canReadRevision(tx, c, b.id, r2))).toBe(true);
  });

  it("a revision-scoped grant to the current revision grants briefing read until a newer revision is published", async () => {
    const b = await makeBriefing({ owner: "riley", visibility: "restricted", revisions: 1 });
    await grant(b.id, "casey", "reader", b.revisionIds[0]);
    expect(sorted(await caps("casey", b.id))).toEqual(READ);
    await system(async (tx) => {
      const [r] = await tx
        .insert(briefingRevisions)
        .values({
          organizationId: seed.orgs.acme.id,
          briefingId: b.id,
          number: 2,
          documentJson: {},
          schemaVersion: 1,
          contentHash: "h2",
          createdBy: seed.users.riley,
        })
        .returning();
      const [p] = await tx
        .insert(publications)
        .values({ organizationId: seed.orgs.acme.id, briefingId: b.id, revisionId: r!.id, publishedBy: seed.users.riley })
        .returning();
      await tx.update(briefings).set({ currentPublicationId: p!.id }).where(eq(briefings.id, b.id));
    });
    expect(sorted(await caps("casey", b.id))).toEqual([]);
  });

  it("canReadRevision rejects a revision of a different briefing", async () => {
    const a = await makeBriefing({ visibility: "company" });
    const b = await makeBriefing({ visibility: "company" });
    expect(await as("jordan", (tx, c) => canReadRevision(tx, c, a.id, b.revisionIds[0]!))).toBe(false);
    expect(await as("jordan", (tx, c) => canReadRevision(tx, c, a.id, a.revisionIds[0]!))).toBe(true);
  });
});

describe("readablePublishedBriefingsCondition", () => {
  it("matches per-briefing read capability for every user, and excludes drafts", async () => {
    const fixtures = [
      await makeBriefing({ owner: "maya", visibility: "company" }),
      await makeBriefing({ owner: "riley", visibility: "team", audienceTeam: "platform" }),
      await makeBriefing({ owner: "riley", visibility: "department", audienceDepartment: "product" }),
      await makeBriefing({ owner: "riley", visibility: "department", audienceDepartment: "go-to-market" }),
      await makeBriefing({ owner: "maya", visibility: "restricted" }),
      await makeBriefing({ owner: "riley", visibility: "restricted", revisions: 2 }),
      await makeBriefing({ owner: "maya", visibility: "company", revisions: 0 }),
    ];
    await grant(fixtures[4]!.id, "jordan", "reader");
    await grant(fixtures[4]!.id, "sam", "editor");
    await grant(fixtures[5]!.id, "casey", "reader", fixtures[5]!.revisionIds[0]);
    await grant(fixtures[5]!.id, "priya", "reader", fixtures[5]!.revisionIds[1]);
    const ids = fixtures.map((f) => f.id);

    for (const user of ["riley", "maya", "alex", "priya", "jordan", "sam", "casey"] as const) {
      const listed = await as(user, (tx, c) =>
        tx
          .select({ id: briefings.id })
          .from(briefings)
          .where(and(readablePublishedBriefingsCondition(c), inArray(briefings.id, ids))),
      );
      const expected: string[] = [];
      for (const f of fixtures) {
        if (f.revisionIds.length > 0 && (await caps(user, f.id)).has("read")) expected.push(f.id);
      }
      expect(listed.map((r) => r.id).sort(), user).toEqual(expected.sort());
    }

    const mayaList = await as("maya", (tx, c) =>
      tx.select({ id: briefings.id }).from(briefings).where(readablePublishedBriefingsCondition(c)),
    );
    expect(mayaList.map((r) => r.id)).not.toContain(fixtures[6]!.id);
  });
});
