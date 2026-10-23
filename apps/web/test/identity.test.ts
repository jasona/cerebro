/**
 * Web identity (D08): AUTH_MODE gating and the Clerk → Cerebro user mapping,
 * with Clerk mocked at the module boundary (`@clerk/nextjs/server`). Clerk only
 * authenticates; these tests check what Cerebro does with a verified session.
 */
import { createInvitation } from "@cerebro/domain";
import { userIdentities, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWorld, type TestWorld } from "../../../packages/domain/src/testing";
import { AuthModeConfigError, resolveAuthMode } from "../lib/auth-mode";

vi.mock("server-only", () => ({}));

const clerk = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => clerk);

const { resolveClerkSession } = await import("../lib/clerk-identity");

const ISS = "https://clerk.cerebro.test";

describe("AUTH_MODE gating", () => {
  it("refuses the dev sign-in in production, with no override", () => {
    expect(() => resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(AuthModeConfigError);
    expect(() => resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: " DEV " })).toThrow(/refused when NODE_ENV=production/);
    expect(() =>
      resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: "dev", CEREBRO_ALLOW_DEV_CONNECTION_TOKENS: "1" }),
    ).toThrow(AuthModeConfigError);
  });

  it("fails closed to Clerk in production and defaults to dev elsewhere", () => {
    expect(resolveAuthMode({ NODE_ENV: "production" })).toBe("clerk");
    expect(resolveAuthMode({ NODE_ENV: "production", AUTH_MODE: "clerk" })).toBe("clerk");
    expect(resolveAuthMode({ NODE_ENV: "development" })).toBe("dev");
    expect(resolveAuthMode({ NODE_ENV: "test", AUTH_MODE: "dev" })).toBe("dev");
    expect(resolveAuthMode({ NODE_ENV: "development", AUTH_MODE: "clerk" })).toBe("clerk");
  });

  it("rejects unknown modes instead of guessing", () => {
    expect(() => resolveAuthMode({ NODE_ENV: "development", AUTH_MODE: "none" })).toThrow(AuthModeConfigError);
  });
});

describe("Clerk session → Cerebro user", () => {
  let w: TestWorld;

  beforeEach(async () => {
    w = await createTestWorld();
    clerk.auth.mockReset();
    clerk.currentUser.mockReset();
  });
  afterEach(async () => {
    await w.h.close();
  });

  const signedIn = (userId: string, iss = ISS) =>
    clerk.auth.mockResolvedValue({ userId, sessionClaims: iss ? { iss, sub: userId } : {} });
  const profile = (email: string, verified = true, name: Partial<{ firstName: string; lastName: string }> = {}) =>
    clerk.currentUser.mockResolvedValue({
      firstName: name.firstName ?? null,
      lastName: name.lastName ?? null,
      username: null,
      primaryEmailAddressId: "em_1",
      emailAddresses: [
        { id: "em_0", emailAddress: "secondary@elsewhere.example", verification: { status: "verified" } },
        { id: "em_1", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
      ],
    });

  it("is signed out without a Clerk user", async () => {
    clerk.auth.mockResolvedValue({ userId: null, sessionClaims: null });
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "signed_out" });
    expect(clerk.currentUser).not.toHaveBeenCalled();
  });

  it("refuses a session without an issuer claim", async () => {
    signedIn("user_1", "");
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "missing_issuer" });
  });

  it("does not create a user for an uninvited verified email (no domain auto-join)", async () => {
    signedIn("user_1");
    profile("newcomer@acme.example");
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "not_invited" });
  });

  it("provisions an invited user on first sign-in, then resolves by link without calling Clerk's user API", async () => {
    await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    signedIn("user_new");
    profile("newcomer@acme.example", true, { firstName: "New", lastName: "Comer" });
    const first = await resolveClerkSession(w.h.db);
    expect(first.user).toMatchObject({ name: "New Comer", email: "newcomer@acme.example", authSubject: "clerk|user_new" });
    const link = await withSystemContext(w.h.db, (tx) => tx.select().from(userIdentities).where(eq(userIdentities.subject, "user_new")));
    expect(link).toMatchObject([{ issuer: ISS, userId: first.user!.userId }]);

    clerk.currentUser.mockClear();
    expect((await resolveClerkSession(w.h.db)).user?.userId).toBe(first.user!.userId);
    expect(clerk.currentUser).not.toHaveBeenCalled();
  });

  it("uses only the primary email, and never an unverified one", async () => {
    await createInvitation(w.h.db, w.ctx("riley"), { kind: "membership", email: "newcomer@acme.example" });
    signedIn("user_new");
    profile("newcomer@acme.example", false);
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "email_unverified" });
  });

  it("links an operator-provisioned (unlinked) user once, by verified email", async () => {
    signedIn("user_riley");
    profile("riley@acme.example");
    expect((await resolveClerkSession(w.h.db)).user?.userId).toBe(w.seed.users.riley);
    // A different Clerk user with the same email is not merged into Riley.
    signedIn("user_impostor");
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "identity_conflict" });
  });

  it("keys the link by issuer: the same Clerk user id from another instance is a different identity", async () => {
    signedIn("user_riley");
    profile("riley@acme.example");
    await resolveClerkSession(w.h.db);
    signedIn("user_riley", "https://other-clerk.test");
    expect(await resolveClerkSession(w.h.db)).toEqual({ user: null, reason: "identity_conflict" });
  });
});
