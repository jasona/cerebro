import { auditEvents, invitations, users, withSystemContext } from "@cerebro/database";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { listLibrary } from "../library/index";
import { createTestWorld, type TestWorld } from "../testing";
import {
  acceptInvitation,
  addDepartmentMember,
  addTeamMember,
  archiveDepartment,
  archiveTeam,
  changeMemberRole,
  createDepartment,
  createInvitation,
  createTeam,
  getCompanyBySlug,
  getOrgTree,
  getPeople,
  listInvitations,
  listMembers,
  listMyCompanies,
  previewTeamReparent,
  removeMembership,
  removeTeamMember,
  renameTeam,
  reparentTeam,
  resolveOrgPath,
  revokeInvitation,
} from "./index";
import { sha256Hex } from "./shared";
import { expectDomainError, makeBriefing } from "./test-support";

let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

const audits = (action: string) =>
  withSystemContext(w.h.db, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));

async function createUser(email: string, name: string): Promise<string> {
  const [u] = await withSystemContext(w.h.db, (tx) =>
    tx.insert(users).values({ authSubject: `test|${email}`, email, displayName: name }).returning(),
  );
  return u!.id;
}

describe("companies", () => {
  it("lists only the user's active companies", async () => {
    expect((await listMyCompanies(w.h.db, w.seed.users.maya)).map((c) => c.slug)).toEqual(["acme"]);
    expect(await listMyCompanies(w.h.db, w.seed.users.taylor)).toMatchObject([{ slug: "globex", role: "owner" }]);
    expect(await listMyCompanies(w.h.db, w.seed.users.casey)).toEqual([]);
  });

  it("resolves a company by slug for members only", async () => {
    const res = await getCompanyBySlug(w.h.db, w.seed.users.maya, "acme");
    expect(res.org.slug).toBe("acme");
    expect(res.membership?.role).toBe("member");
    await expectDomainError(getCompanyBySlug(w.h.db, w.seed.users.taylor, "acme"), "not_found");
    await expectDomainError(getCompanyBySlug(w.h.db, w.seed.users.maya, "nope"), "not_found");
  });
});

describe("org tree and structure", () => {
  it("returns departments, teams and member counts to members only", async () => {
    const tree = await getOrgTree(w.h.db, w.ctx("sam"));
    expect(tree.company.slug).toBe("acme");
    expect(tree.departments.map((d) => d.slug).sort()).toEqual(["engineering", "finance", "go-to-market", "product"]);
    const product = tree.departments.find((d) => d.slug === "product")!;
    // maya + alex via Platform/Experience, priya explicitly.
    expect(product.memberCount).toBe(3);
    expect(product.teams.find((t) => t.slug === "platform")!.memberCount).toBe(2);
    await expectDomainError(getOrgTree(w.h.db, w.ctx("casey")), "not_found");
    await expectDomainError(getOrgTree(w.h.db, { ...w.ctx("taylor"), organizationId: w.seed.orgs.acme.id }), "not_found");
    expect((await resolveOrgPath(w.h.db, w.ctx("sam"), { departmentSlug: "product", teamSlug: "platform" })).team?.name).toBe(
      "Platform",
    );
  });

  it("lets only owners/admins create, rename and archive, with audit", async () => {
    await expectDomainError(createDepartment(w.h.db, w.ctx("maya"), { name: "Legal" }), "forbidden");
    await expectDomainError(createDepartment(w.h.db, w.ctx("casey"), { name: "Legal" }), "not_found");
    const legal = await createDepartment(w.h.db, w.ctx("riley"), { name: "Legal & Risk" });
    expect(legal.slug).toBe("legal-risk");
    const again = await createDepartment(w.h.db, w.ctx("riley"), { name: "Legal & Risk" });
    expect(again.slug).toBe("legal-risk-2");
    await expectDomainError(createDepartment(w.h.db, w.ctx("riley"), { name: "X", slug: "legal-risk" }), "conflict");
    const team = await createTeam(w.h.db, w.ctx("riley"), { departmentId: legal.id, name: "Contracts" });
    expect((await renameTeam(w.h.db, w.ctx("riley"), { teamId: team.id, name: "Commercial contracts" })).name).toBe(
      "Commercial contracts",
    );
    await expectDomainError(archiveTeam(w.h.db, w.ctx("maya"), { teamId: team.id }), "forbidden");
    await archiveDepartment(w.h.db, w.ctx("riley"), { departmentId: legal.id });
    const tree = await getOrgTree(w.h.db, w.ctx("riley"));
    expect(tree.departments.find((d) => d.id === legal.id)).toBeUndefined();
    const all = await getOrgTree(w.h.db, w.ctx("riley"), { includeArchived: true });
    expect(all.departments.find((d) => d.id === legal.id)!.teams[0]!.archivedAt).not.toBeNull();
    await expectDomainError(createTeam(w.h.db, w.ctx("riley"), { departmentId: legal.id, name: "Late" }), "conflict");
    expect(await audits("department.created")).toHaveLength(2);
    expect(await audits("team.renamed")).toHaveLength(1);
    expect((await audits("department.archived"))[0]!.metadata).toEqual({ archivedTeamIds: [team.id] });
    // Cross-company ids are not found.
    await expectDomainError(
      createTeam(w.h.db, w.ctx("riley"), { departmentId: w.seed.orgs.globex.departments.operations!, name: "Spy" }),
      "not_found",
    );
  });
});

describe("team reparent", () => {
  it("previews the impact and applies it with audit", async () => {
    const { departments: d, teams: t } = w.seed.orgs.acme;
    const deptAudience = await makeBriefing(w, { visibility: "department", audienceDepartment: "product", title: "Product only" });
    const homed = await makeBriefing(w, { homeTeam: "platform" });
    await makeBriefing(w, { visibility: "department", audienceDepartment: "finance" });

    await expectDomainError(
      previewTeamReparent(w.h.db, w.ctx("maya"), { teamId: t.platform!, newDepartmentId: d.engineering! }),
      "forbidden",
    );
    const impact = await previewTeamReparent(w.h.db, w.ctx("riley"), { teamId: t.platform!, newDepartmentId: d.engineering! });
    expect(impact.fromDepartmentId).toBe(d.product);
    // Alex loses Product (no other Product team); Maya keeps it via Experience.
    expect(impact.usersLosingDepartmentAccess.map((u) => u.displayName)).toEqual(["Alex Rivera"]);
    // Maya gains Engineering; Alex already has it via Infrastructure.
    expect(impact.usersGainingDepartmentAccess.map((u) => u.displayName)).toEqual(["Maya Chen"]);
    expect(impact.departmentAudienceBriefings).toEqual({ count: 1, briefingIds: [deptAudience.id] });
    expect(impact.homedBriefings).toEqual({ count: 1, briefingIds: [homed.id] });
    expect(await audits("team.reparented")).toHaveLength(0);

    const productScope = { scope: { kind: "department" as const, departmentId: d.product! } };
    expect((await listLibrary(w.h.db, w.ctx("alex"), { q: "Product only" })).total).toBe(1);

    const { team } = await reparentTeam(w.h.db, w.ctx("riley"), { teamId: t.platform!, newDepartmentId: d.engineering! });
    expect(team.departmentId).toBe(d.engineering);
    // Derived department access follows immediately.
    expect((await listLibrary(w.h.db, w.ctx("alex"), { q: "Product only" })).total).toBe(0);
    // The team-homed brief moved with its team; its audience did not change.
    const eng = await listLibrary(w.h.db, w.ctx("sam"), { scope: { kind: "department", departmentId: d.engineering! } });
    expect(eng.items.map((r) => r.briefingId)).toEqual([homed.id]);
    expect((await listLibrary(w.h.db, w.ctx("sam"), productScope)).items.map((r) => r.briefingId)).not.toContain(homed.id);
    const [audit] = await audits("team.reparented");
    expect(audit!.metadata).toMatchObject({ fromDepartmentId: d.product, toDepartmentId: d.engineering, homedBriefingIds: [homed.id] });
    await expectDomainError(
      reparentTeam(w.h.db, w.ctx("riley"), { teamId: t.platform!, newDepartmentId: d.engineering! }),
      "validation",
    );
  });
});

describe("memberships", () => {
  it("lists members with teams for admins, and the directory for members", async () => {
    const members = await listMembers(w.h.db, w.ctx("riley"));
    const maya = members.find((m) => m.userId === w.seed.users.maya)!;
    expect(maya.teams.map((t) => t.slug).sort()).toEqual(["experience", "platform"]);
    expect(maya.email).toBe("maya@acme.example");
    expect(members.find((m) => m.userId === w.seed.users.priya)!.departments.map((d) => d.slug)).toEqual(["product"]);
    await expectDomainError(listMembers(w.h.db, w.ctx("maya")), "forbidden");
    const people = await getPeople(w.h.db, w.ctx("sam"));
    expect(people).toHaveLength(6);
    expect(people[0]).not.toHaveProperty("email");
    expect((await getPeople(w.h.db, w.ctx("sam"), { q: "ali" }))).toHaveLength(0);
    expect((await getPeople(w.h.db, w.ctx("sam"), { q: "riv" })).map((p) => p.displayName)).toEqual(["Alex Rivera"]);
    await expectDomainError(getPeople(w.h.db, w.ctx("casey")), "not_found");
  });

  it("adds and removes team and department membership with audit", async () => {
    const { teams: t, departments: d } = w.seed.orgs.acme;
    await addTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.sam });
    await addTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.sam }); // idempotent
    expect(await audits("team_membership.added")).toHaveLength(1);
    await removeTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.sam });
    await expectDomainError(removeTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.sam }), "not_found");
    await addTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.sam });
    expect(await audits("team_membership.added")).toHaveLength(2);
    await addDepartmentMember(w.h.db, w.ctx("riley"), { departmentId: d.finance!, userId: w.seed.users.sam });
    expect(await audits("department_membership.added")).toHaveLength(1);
    await expectDomainError(addTeamMember(w.h.db, w.ctx("maya"), { teamId: t.sales!, userId: w.seed.users.maya }), "forbidden");
    await expectDomainError(
      addTeamMember(w.h.db, w.ctx("riley"), { teamId: t.sales!, userId: w.seed.users.casey }),
      "not_found",
    );
  });

  it("restricts owner/admin role changes to owners and keeps one owner", async () => {
    await changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.maya, role: "admin" });
    await expectDomainError(changeMemberRole(w.h.db, w.ctx("maya"), { userId: w.seed.users.sam, role: "admin" }), "forbidden");
    await expectDomainError(changeMemberRole(w.h.db, w.ctx("maya"), { userId: w.seed.users.riley, role: "member" }), "forbidden");
    await expectDomainError(changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.riley, role: "member" }), "conflict");
    await expectDomainError(removeMembership(w.h.db, w.ctx("maya"), { userId: w.seed.users.riley }), "forbidden");
    expect((await audits("membership.role_changed"))[0]!.metadata).toMatchObject({ from: "member", to: "admin" });
  });

  it("removing a membership ends derived access", async () => {
    const teamBrief = await makeBriefing(w, { visibility: "team", audienceTeam: "applications" });
    expect((await listLibrary(w.h.db, w.ctx("sam"))).items.map((r) => r.briefingId)).toEqual([teamBrief.id]);
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectDomainError(listLibrary(w.h.db, w.ctx("sam")), "not_found");
    expect(await listMyCompanies(w.h.db, w.seed.users.sam)).toEqual([]);
    expect((await listMembers(w.h.db, w.ctx("riley"), { includeRemoved: true })).find((m) => m.userId === w.seed.users.sam)!.status).toBe(
      "removed",
    );
    expect(await audits("membership.removed")).toHaveLength(1);
  });
});

describe("invitations", () => {
  it("binds membership acceptance to the invited email", async () => {
    await expectDomainError(
      createInvitation(w.h.db, w.ctx("maya"), { kind: "membership", email: "new@acme.example" }),
      "forbidden",
    );
    const { invitation, token } = await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: " New@Acme.example " });
    expect(invitation).toMatchObject({ email: "new@acme.example", kind: "membership", role: "member", status: "pending" });
    expect(token).toMatch(/^cbi_[0-9A-Za-z]{43,}$/);
    const [row] = await withSystemContext(w.h.db, (tx) => tx.select().from(invitations).where(eq(invitations.id, invitation.id)));
    expect(row!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const newcomer = await createUser("new@acme.example", "Nia Newcomer");
    await expectDomainError(acceptInvitation(w.h.db, { token, userId: w.seed.users.casey }), "forbidden");
    await expectDomainError(acceptInvitation(w.h.db, { token: "cbi_wrong-token-value", userId: newcomer }), "not_found");
    const accepted = await acceptInvitation(w.h.db, { token, userId: newcomer });
    expect(accepted).toMatchObject({ kind: "membership", organizationSlug: "acme", role: "member" });
    expect((await listMyCompanies(w.h.db, newcomer)).map((c) => c.slug)).toEqual(["acme"]);
    await expectDomainError(acceptInvitation(w.h.db, { token, userId: newcomer }), "conflict");
    expect(await audits("invitation.accepted")).toHaveLength(1);
    expect(await audits("membership.added")).toHaveLength(1);
    // Admin invitations need an owner.
    await changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.maya, role: "admin" });
    await expectDomainError(
      createInvitation(w.h.db, w.ctx("maya"), { kind: "membership", email: "x@acme.example", role: "admin" }),
      "forbidden",
    );
  });

  it("creates a briefing grant for an external reader, and honours revocation and expiry", async () => {
    const b = await makeBriefing(w, { owner: "maya", visibility: "restricted" });
    await expectDomainError(
      createInvitation(w.h.db, w.ctx("sam"), { kind: "briefing", email: "casey@partner.example", briefingId: b.id }),
      "not_found",
    );
    const { token } = await createInvitation(w.h.db, w.ctx("maya"), {
      kind: "briefing",
      email: "casey@partner.example",
      briefingId: b.id,
    });
    const accepted = await acceptInvitation(w.h.db, { token, userId: w.seed.users.casey });
    expect(accepted).toMatchObject({ kind: "briefing", briefingId: b.id, briefingSlug: b.slug, grantRole: "reader" });
    expect((await getCompanyBySlug(w.h.db, w.seed.users.casey, "acme", { briefingSlug: b.slug })).membership).toBeNull();
    // External readers still cannot browse.
    await expectDomainError(listLibrary(w.h.db, w.ctx("casey")), "not_found");
    expect(await audits("grant.created")).toHaveLength(1);

    // Editor invitation needs membership at acceptance.
    const editor = await createInvitation(w.h.db, w.ctx("maya"), {
      kind: "briefing",
      email: "casey@partner.example",
      briefingId: b.id,
      grantRole: "editor",
    });
    await expectDomainError(acceptInvitation(w.h.db, { token: editor.token, userId: w.seed.users.casey }), "forbidden");

    const revoked = await createInvitation(w.h.db, w.ctx("maya"), { kind: "briefing", email: "sam@acme.example", briefingId: b.id });
    expect(await listInvitations(w.h.db, w.ctx("maya"), { briefingId: b.id })).toHaveLength(2);
    await revokeInvitation(w.h.db, w.ctx("maya"), { invitationId: revoked.invitation.id });
    await expectDomainError(acceptInvitation(w.h.db, { token: revoked.token, userId: w.seed.users.sam }), "conflict");

    const expiring = await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "casey@partner.example" });
    await withSystemContext(w.h.db, (tx) =>
      tx
        .update(invitations)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(and(eq(invitations.id, expiring.invitation.id))),
    );
    await expectDomainError(acceptInvitation(w.h.db, { token: expiring.token, userId: w.seed.users.casey }), "conflict");
    expect(await listInvitations(w.h.db, w.ctx("riley"))).toEqual([]);
  });
});
