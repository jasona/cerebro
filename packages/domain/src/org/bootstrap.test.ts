import { auditEvents, memberships, users, withSystemContext } from "@cerebro/database";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { listMyCompanies, resolveWebIdentity } from "../index";
import { createTestWorld, type TestWorld } from "../testing";
import { bootstrapAuthSubject, bootstrapOrganization } from "./bootstrap";

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.h.close();
  w = undefined;
});

describe("bootstrapOrganization (org:bootstrap)", () => {
  it("creates a company and an owner whose first verified sign-in claims the account", async () => {
    w = await createTestWorld();
    const r = await bootstrapOrganization(w.h.db, {
      slug: "initech",
      name: "Initech",
      ownerEmail: " Founder@Initech.Example ",
      ownerName: "Pat Founder",
    });
    expect(r).toMatchObject({ status: "created", slug: "initech", userCreated: true });

    const [user] = await withSystemContext(w.h.db, (tx) => tx.select().from(users).where(eq(users.id, r.userId)));
    expect(user).toMatchObject({ email: "founder@initech.example", displayName: "Pat Founder", authSubject: bootstrapAuthSubject("founder@initech.example") });
    expect(await listMyCompanies(w.h.db, r.userId)).toEqual([
      expect.objectContaining({ slug: "initech", name: "Initech", role: "owner" }),
    ]);
    const audit = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.organizationId, r.organizationId), eq(auditEvents.action, "organization.bootstrapped"))),
    );
    expect(audit).toHaveLength(1);

    const signIn = await resolveWebIdentity(w.h.db, {
      issuer: "https://clerk.initech.example",
      subject: "user_founder",
      email: "founder@initech.example",
      emailVerified: true,
      displayName: "Pat",
      authSubject: "clerk|user_founder",
    });
    expect(signIn).toMatchObject({ status: "claimed", user: { userId: r.userId } });
  });

  it("is idempotent for the same owner and reuses an existing user", async () => {
    w = await createTestWorld();
    const first = await bootstrapOrganization(w.h.db, { slug: "initech", name: "Initech", ownerEmail: "maya@acme.example" });
    expect(first).toMatchObject({ status: "created", userId: w.seed.users.maya, userCreated: false });
    const again = await bootstrapOrganization(w.h.db, { slug: "initech", name: "Initech", ownerEmail: "MAYA@acme.example" });
    expect(again).toEqual({ ...first, status: "unchanged" });
  });

  it("never grants owner rights in an existing company", async () => {
    w = await createTestWorld();
    // Maya is a member of Acme, not its owner; Casey has no membership.
    for (const ownerEmail of ["maya@acme.example", "casey@partner.example", "new@acme.example"]) {
      await expect(bootstrapOrganization(w.h.db, { slug: "acme", name: "Acme", ownerEmail })).rejects.toMatchObject({ code: "conflict" });
    }
    const rows = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(memberships).where(and(eq(memberships.organizationId, w!.seed.orgs.acme.id), eq(memberships.role, "owner"))),
    );
    expect(rows.map((m) => m.userId)).toEqual([w.seed.users.riley]);
    const created = await withSystemContext(w.h.db, (tx) => tx.select().from(users).where(eq(users.email, "new@acme.example")));
    expect(created).toEqual([]);
  });

  it("validates the slug, name and email", async () => {
    w = await createTestWorld();
    for (const bad of [
      { slug: "Bad Slug", name: "X", ownerEmail: "a@b.example" },
      { slug: "ok", name: " ", ownerEmail: "a@b.example" },
      { slug: "ok", name: "X", ownerEmail: "not-an-email" },
    ]) {
      await expect(bootstrapOrganization(w.h.db, bad)).rejects.toMatchObject({ code: "validation" });
    }
  });
});
