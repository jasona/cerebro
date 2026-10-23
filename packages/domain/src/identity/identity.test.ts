import { memberships, userIdentities, users, withSystemContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptInvitation, createInvitation, revokeInvitation } from "../org/index";
import { createTestWorld, type TestWorld } from "../testing";
import { findUserByIdentity, resolveWebIdentity, type WebIdentityInput } from "./index";

const CLERK_ISS = "https://clerk.cerebro.test";

let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

const signIn = (over: Partial<WebIdentityInput> = {}): WebIdentityInput => ({
  issuer: CLERK_ISS,
  subject: "user_new",
  email: "newcomer@acme.example",
  emailVerified: true,
  displayName: "New Comer",
  authSubject: "clerk|user_new",
  ...over,
});

const userCount = async () =>
  (await withSystemContext(w.h.db, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from users`))).rows[0]!.n;

describe("web identity provisioning (D08)", () => {
  it("refuses a first sign-in with no account and no pending invitation, creating nothing", async () => {
    const before = await userCount();
    expect(await resolveWebIdentity(w.h.db, signIn())).toEqual({ status: "not_invited" });
    // No email-domain auto-join: an @acme.example address alone is not enough.
    expect(await userCount()).toBe(before);
    expect(await findUserByIdentity(w.h.db, { issuer: CLERK_ISS, subject: "user_new" })).toBeNull();
  });

  it("provisions a user (but no membership) through a pending invitation, then links on later sign-ins", async () => {
    const { token } = await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "Newcomer@Acme.example" });
    const first = await resolveWebIdentity(w.h.db, signIn({ email: "NEWCOMER@acme.example" }));
    expect(first.status).toBe("provisioned");
    if (!("user" in first)) throw new Error("expected a user");
    expect(first.user).toMatchObject({ email: "newcomer@acme.example", name: "New Comer", authSubject: "clerk|user_new" });

    // Signing in does not join the company; accepting the invitation does.
    const before = await withSystemContext(w.h.db, (tx) => tx.select().from(memberships).where(eq(memberships.userId, first.user.userId)));
    expect(before).toHaveLength(0);
    await acceptInvitation(w.h.db, { token, userId: first.user.userId });

    const again = await resolveWebIdentity(w.h.db, signIn({ displayName: "Changed" }));
    expect(again).toEqual({ status: "linked", user: first.user });
    expect(await findUserByIdentity(w.h.db, { issuer: CLERK_ISS, subject: "user_new" })).toEqual(first.user);
  });

  it("does not provision through revoked or expired invitations", async () => {
    const { invitation } = await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    await revokeInvitation(w.h.db, w.ctx("riley"), { invitationId: invitation.id });
    expect((await resolveWebIdentity(w.h.db, signIn())).status).toBe("not_invited");

    await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    await withSystemContext(w.h.db, (tx) => tx.execute(sql`update invitations set expires_at = now() - interval '1 minute'`));
    expect((await resolveWebIdentity(w.h.db, signIn())).status).toBe("not_invited");
  });

  it("never provisions or links an unverified email", async () => {
    await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    expect(await resolveWebIdentity(w.h.db, signIn({ emailVerified: false }))).toEqual({ status: "email_unverified" });
    expect(await resolveWebIdentity(w.h.db, signIn({ subject: "user_x", email: "maya@acme.example", emailVerified: false }))).toEqual({
      status: "email_unverified",
    });
  });

  it("claims an unlinked pre-provisioned user by verified email once; other identities are never merged", async () => {
    const claimed = await resolveWebIdentity(w.h.db, signIn({ subject: "user_maya", email: "maya@acme.example" }));
    expect(claimed.status).toBe("claimed");
    if (!("user" in claimed)) throw new Error("expected a user");
    expect(claimed.user.userId).toBe(w.seed.users.maya);

    // A second identity with the same email (same or another issuer) is a conflict.
    expect(await resolveWebIdentity(w.h.db, signIn({ subject: "user_maya_2", email: "maya@acme.example" }))).toEqual({
      status: "identity_conflict",
    });
    expect(
      await resolveWebIdentity(w.h.db, signIn({ issuer: "https://other.test", subject: "user_maya", email: "maya@acme.example" })),
    ).toEqual({ status: "identity_conflict" });
    const links = await withSystemContext(w.h.db, (tx) => tx.select().from(userIdentities).where(eq(userIdentities.userId, w.seed.users.maya)));
    expect(links).toHaveLength(1);
  });

  it("is safe under concurrent first sign-ins", async () => {
    await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    const [a, b] = await Promise.all([resolveWebIdentity(w.h.db, signIn()), resolveWebIdentity(w.h.db, signIn())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["linked", "provisioned"]);
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(users).where(eq(users.email, "newcomer@acme.example")));
    expect(rows).toHaveLength(1);
  });
});
