import { integrationConnections, integrationOperations, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addTeamMember, archiveTeam, createTeam, removeMembership, removeTeamMember } from "../org/index";
import { sha256Hex } from "../org/shared";
import { expectDomainError, makeBriefing } from "../org/test-support";
import { createTestWorld, type TestWorld } from "../testing";
import {
  authenticateConnectionToken,
  createConnectionToken,
  getAuthoringContext,
  getAuthoringPreferences,
  getOperation,
  listConnections,
  operationInputDigest,
  resolveAudience,
  resolveDestination,
  revokeConnection,
  runIdempotent,
  setAuthoringPreferences,
} from "./index";

let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

describe("connection tokens", () => {
  it("creates, authenticates and revokes a token", async () => {
    const { connection, token } = await createConnectionToken(w.h.db, w.ctx("maya"), { label: "ChatGPT" });
    expect(token).toMatch(/^cbr_[0-9A-Za-z]{43,}$/);
    expect(connection).toMatchObject({ label: "ChatGPT", kind: "dev_token", status: "active", lastUsedAt: null });
    expect(token.startsWith(connection.tokenPrefix!)).toBe(true);
    const [row] = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(integrationConnections).where(eq(integrationConnections.id, connection.id)),
    );
    expect(row!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const ctx = await authenticateConnectionToken(w.h.db, token);
    expect(ctx).toMatchObject({
      userId: w.seed.users.maya,
      organizationId: w.seed.orgs.acme.id,
      via: "mcp",
      connectionId: connection.id,
    });
    expect((await listConnections(w.h.db, w.ctx("maya")))[0]!.lastUsedAt).toBeInstanceOf(Date);
    expect(await listConnections(w.h.db, w.ctx("sam"))).toEqual([]);

    await expectDomainError(revokeConnection(w.h.db, w.ctx("sam"), { connectionId: connection.id }), "not_found");
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: connection.id });
    await expectDomainError(authenticateConnectionToken(w.h.db, token), "unauthenticated");
  });

  it("rejects malformed and unknown tokens, and creation over MCP", async () => {
    await expectDomainError(authenticateConnectionToken(w.h.db, "not-a-token"), "unauthenticated");
    await expectDomainError(authenticateConnectionToken(w.h.db, `cbr_${"A".repeat(43)}`), "unauthenticated");
    await expectDomainError(createConnectionToken(w.h.db, w.ctx("maya", "acme", "mcp"), { label: "x" }), "forbidden");
    await expectDomainError(createConnectionToken(w.h.db, w.ctx("casey"), { label: "x" }), "not_found");
  });

  it("a removed membership blocks token authentication", async () => {
    const { token } = await createConnectionToken(w.h.db, w.ctx("sam"), { label: "Claude" });
    await authenticateConnectionToken(w.h.db, token);
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectDomainError(authenticateConnectionToken(w.h.db, token), "unauthenticated");
  });
});

describe("destinations", () => {
  it("resolves natural-language destinations among authorized homes", async () => {
    const maya = w.ctx("maya");
    const { teams: t, departments: d } = w.seed.orgs.acme;
    expect(await resolveDestination(w.h.db, maya, { text: "Send this to the Platform team" })).toMatchObject({
      status: "resolved",
      source: "text",
      home: { kind: "team", teamId: t.platform, departmentId: d.product, label: "Acme / Product / Platform" },
    });
    expect(await resolveDestination(w.h.db, maya, { text: "platfrom" })).toMatchObject({ status: "resolved", home: { teamId: t.platform } });
    expect(await resolveDestination(w.h.db, maya, { text: "the Product department" })).toMatchObject({
      status: "resolved",
      home: { kind: "department", departmentId: d.product },
    });
    for (const text of ["company-wide", "Everyone", "the company", "Acme"]) {
      expect(await resolveDestination(w.h.db, maya, { text })).toMatchObject({ status: "resolved", home: { kind: "company" } });
    }
    expect(await resolveDestination(w.h.db, maya, { text: "Marketing team" })).toMatchObject({ status: "none", reason: "not_authorized" });
    expect(await resolveDestination(w.h.db, maya, { text: "Quantum lab" })).toMatchObject({ status: "none", reason: "no_match" });
  });

  it("reports ambiguity when two authorized teams match", async () => {
    const platform2 = await createTeam(w.h.db, w.ctx("riley"), { departmentId: w.seed.orgs.acme.departments.engineering!, name: "Platform" });
    await addTeamMember(w.h.db, w.ctx("riley"), { teamId: platform2.id, userId: w.seed.users.maya });
    const res = await resolveDestination(w.h.db, w.ctx("maya"), { text: "Platform" });
    expect(res.status).toBe("ambiguous");
    if (res.status !== "ambiguous") throw new Error("unreachable");
    expect(res.candidates.map((c) => c.label).sort()).toEqual(["Acme / Engineering / Platform", "Acme / Product / Platform"]);
    expect(await resolveDestination(w.h.db, w.ctx("maya"), { text: "Platform team in Engineering" })).toMatchObject({
      status: "resolved",
      home: { teamId: platform2.id },
    });
  });

  it("re-resolves untrusted ids within the context company", async () => {
    const maya = w.ctx("maya");
    const { teams: t, departments: d } = w.seed.orgs.acme;
    expect(await resolveDestination(w.h.db, maya, { teamId: w.seed.orgs.globex.teams.logistics! })).toMatchObject({
      status: "none",
      reason: "not_found",
    });
    expect(await resolveDestination(w.h.db, maya, { teamId: "not-a-uuid" })).toMatchObject({ status: "none", reason: "not_found" });
    expect(await resolveDestination(w.h.db, maya, { teamId: t.marketing! })).toMatchObject({ status: "none", reason: "not_authorized" });
    expect(await resolveDestination(w.h.db, maya, { teamId: t.platform!, departmentId: d.finance! })).toMatchObject({
      status: "none",
      reason: "mismatch",
    });
    expect(await resolveDestination(w.h.db, maya, { teamId: t.platform! })).toMatchObject({ status: "resolved", source: "id" });
    expect(await resolveDestination(w.h.db, maya, { departmentId: d.finance! })).toMatchObject({ status: "none", reason: "not_authorized" });
    // Globex's owner cannot resolve inside Acme.
    await expectDomainError(
      resolveDestination(w.h.db, { ...w.ctx("taylor"), organizationId: w.seed.orgs.acme.id }, { text: "Platform" }),
      "not_found",
    );
  });

  it("remembers preferences and flags stale ones without using them", async () => {
    const maya = w.ctx("maya");
    const { teams: t, departments: d } = w.seed.orgs.acme;
    expect(await resolveDestination(w.h.db, maya, {})).toMatchObject({ status: "none", reason: "no_default" });
    await expectDomainError(setAuthoringPreferences(w.h.db, maya, { defaultTeamId: t.marketing! }), "forbidden");
    const prefs = await setAuthoringPreferences(w.h.db, maya, { defaultTeamId: t.platform!, preferredStyle: "concise" });
    expect(prefs).toMatchObject({
      defaultDepartment: { id: d.product, stale: false },
      defaultTeam: { id: t.platform, name: "Platform", stale: false },
      preferredStyle: "concise",
      defaultHome: { kind: "team", teamId: t.platform },
    });
    expect(await resolveDestination(w.h.db, maya, {})).toMatchObject({ status: "resolved", source: "preference" });

    await removeTeamMember(w.h.db, w.ctx("riley"), { teamId: t.platform!, userId: w.seed.users.maya });
    const stale = await getAuthoringPreferences(w.h.db, maya);
    expect(stale.defaultTeam).toMatchObject({ stale: true, staleReason: "not_accessible" });
    expect(stale.defaultHome).toBeNull();
    expect(await resolveDestination(w.h.db, maya, {})).toMatchObject({ status: "none", reason: "no_default" });

    await setAuthoringPreferences(w.h.db, maya, { defaultTeamId: t.experience! });
    await archiveTeam(w.h.db, w.ctx("riley"), { teamId: t.experience! });
    expect((await getAuthoringPreferences(w.h.db, maya)).defaultTeam).toMatchObject({ stale: true, staleReason: "archived" });
    const cleared = await setAuthoringPreferences(w.h.db, maya, { defaultTeamId: null, defaultDepartmentId: null });
    expect(cleared).toMatchObject({ defaultTeam: null, defaultDepartment: null, preferredStyle: "concise", defaultHome: null });
  });

  it("returns the authoring context with membership-derived destinations", async () => {
    const ctx = await getAuthoringContext(w.h.db, w.ctx("maya", "acme", "mcp"));
    expect(ctx.company.slug).toBe("acme");
    expect(ctx.user).toMatchObject({ displayName: "Maya Chen", role: "member" });
    expect(ctx.destinations.company.kind).toBe("company");
    expect(ctx.destinations.departments.map((x) => x.departmentSlug)).toEqual(["product"]);
    expect(ctx.destinations.teams.map((x) => x.teamSlug)).toEqual(["experience", "platform"]);
    expect(ctx.capabilities).toMatchObject({ canCreateBriefs: true, canManageStructure: false, canCreateConnectionToken: false });
    const priya = await getAuthoringContext(w.h.db, w.ctx("priya"));
    expect(priya.destinations.departments.map((x) => x.departmentSlug)).toEqual(["finance", "product"]);
    expect((await getAuthoringContext(w.h.db, w.ctx("riley"))).capabilities.canManageStructure).toBe(true);
    await expectDomainError(getAuthoringContext(w.h.db, w.ctx("casey")), "not_found");
  });
});

describe("audience", () => {
  it("validates audience ids in-org and resolves named readers", async () => {
    const maya = w.ctx("maya");
    const { teams: t, departments: d } = w.seed.orgs.acme;
    expect(await resolveAudience(w.h.db, maya, { visibility: "company" })).toMatchObject({ label: "Everyone at Acme", readers: [] });
    expect(await resolveAudience(w.h.db, maya, { visibility: "team", teamId: t.marketing! })).toMatchObject({
      visibility: "team",
      teamId: t.marketing,
      departmentId: null,
      label: "Marketing team",
    });
    expect(await resolveAudience(w.h.db, maya, { visibility: "department", departmentId: d.finance! })).toMatchObject({
      label: "Finance department",
    });
    await expectDomainError(resolveAudience(w.h.db, maya, { visibility: "team", teamId: w.seed.orgs.globex.teams.logistics! }), "not_found");
    await expectDomainError(resolveAudience(w.h.db, maya, { visibility: "team" }), "validation");
    await expectDomainError(resolveAudience(w.h.db, maya, { visibility: "company", teamId: t.platform! }), "validation");
    await expectDomainError(resolveAudience(w.h.db, maya, { visibility: "restricted" }), "validation");

    const spec = await resolveAudience(w.h.db, maya, {
      visibility: "restricted",
      readerEmails: ["Sam@acme.example", "casey@partner.example", "someone@else.example", "sam@acme.example"],
    });
    expect(spec.label).toBe("Named readers only");
    expect(spec.audience).toEqual({ visibility: "restricted", departmentId: null, teamId: null, readerUserIds: [w.seed.users.sam] });
    expect(spec.readers).toEqual([{ userId: w.seed.users.sam, email: "sam@acme.example", displayName: "Sam Taylor", isMember: true }]);
    // Casey has no relationship with Acme yet, so she is not visible: invitation intent.
    expect(spec.invitations).toEqual([{ email: "casey@partner.example" }, { email: "someone@else.example" }]);
  });
});

describe("idempotent operations", () => {
  const result = (id: string) => ({ resultRef: { type: "briefing", id }, result: { briefingId: id, draftVersion: 1 } });

  it("replays the same key and input, rejects a changed input", async () => {
    const b = await makeBriefing(w, { owner: "maya" });
    const ctx = w.ctx("maya", "acme", "mcp");
    let calls = 0;
    const run = (input: unknown, key = "key-1") =>
      runIdempotent(w.h.db, ctx, { action: "create_brief_draft", idempotencyKey: key, input }, async () => {
        calls++;
        return result(b.id);
      });
    const first = await run({ title: "Plan", sections: [1, 2] });
    expect(first).toMatchObject({ replayed: false, resultRef: { type: "briefing", id: b.id } });
    const again = await run({ sections: [1, 2], title: "Plan" }); // key order does not matter
    expect(again).toMatchObject({ replayed: true, operationId: first.operationId, result: { briefingId: b.id, draftVersion: 1 } });
    expect(calls).toBe(1);
    await expectDomainError(run({ title: "Different" }), "idempotency_mismatch");
    await run({ title: "Different" }, "key-2");
    expect(calls).toBe(2);

    const [op] = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(integrationOperations).where(eq(integrationOperations.id, first.operationId)),
    );
    expect(op).toMatchObject({ status: "succeeded", resourceType: "briefing", resourceId: b.id, inputDigest: operationInputDigest({ title: "Plan", sections: [1, 2] }) });
    expect(JSON.stringify(op)).not.toContain("Plan");

    expect(await getOperation(w.h.db, ctx, first.operationId)).toMatchObject({ status: "succeeded", resultRef: { id: b.id } });
    await expectDomainError(getOperation(w.h.db, w.ctx("sam"), first.operationId), "not_found");
  });

  it("records nothing when the mutation fails, so a retry runs", async () => {
    const ctx = w.ctx("maya");
    const input = { action: "publish_brief", idempotencyKey: "k", input: { a: 1 } };
    await expect(
      runIdempotent(w.h.db, ctx, input, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const ok = await runIdempotent(w.h.db, ctx, input, async () => ({ resultRef: null, result: { ok: true } }));
    expect(ok.replayed).toBe(false);
  });

  it("rechecks authorization on replay and on getOperation", async () => {
    const b = await makeBriefing(w, { owner: "sam", visibility: "restricted" });
    const ctx = w.ctx("sam");
    const input = { action: "create_brief_draft", idempotencyKey: "k", input: {} };
    const first = await runIdempotent(w.h.db, ctx, input, async () => result(b.id));
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectDomainError(runIdempotent(w.h.db, ctx, input, async () => result(b.id)), "forbidden");
    await expectDomainError(getOperation(w.h.db, ctx, first.operationId), "not_found");
  });
});
