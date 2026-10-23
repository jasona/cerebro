/**
 * MCP connections end with the company membership (D10 extended to
 * integration connections). Removing a member revokes their connections in
 * that company, audited; a re-invited member's previously authorized LLM
 * hosts do not silently regain access, exactly as earlier briefing grants
 * do not. OAuth hosts must authorize again (a later `auth_time`).
 */
import { auditEvents, integrationConnections, memberships, userIdentities } from "@cerebro/database";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateConnectionToken, authenticateOAuthGrant, createConnectionToken, listConnections } from "../../src/integration/index";
import { removeMembership } from "../../src/org/index";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { expectCode, sys } from "./helpers";

const ISSUER = "https://auth.example.test";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  await w.h.close();
});

/** Out-of-band re-activation, as a re-accepted membership invitation does. */
const reactivate = (userId: string) =>
  sys(w, (tx) =>
    tx
      .update(memberships)
      .set({ status: "active" })
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, w.seed.orgs.acme.id))),
  );

describe("membership removal and MCP connections", () => {
  it("revokes the member's connection tokens; re-adding the member does not revive them", async () => {
    const sam = w.seed.users.sam;
    const { token, connection } = await createConnectionToken(w.h.db, w.ctx("sam"), { label: "Host" });
    expect((await authenticateConnectionToken(w.h.db, token)).userId).toBe(sam);

    await removeMembership(w.h.db, w.ctx("riley"), { userId: sam });
    await expectCode(authenticateConnectionToken(w.h.db, token), "unauthenticated");

    await reactivate(sam);
    await expectCode(authenticateConnectionToken(w.h.db, token), "unauthenticated");
    const [row] = await listConnections(w.h.db, w.ctx("sam"));
    expect(row).toMatchObject({ id: connection.id, status: "revoked" });

    const audits = await sys(w, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "connection.revoked")));
    expect(audits.map((a) => a.targetId)).toContain(connection.id);
  });

  it("an OAuth grant authorized before the removal stays refused after re-adding", async () => {
    const sam = w.seed.users.sam;
    await sys(w, (tx) => tx.insert(userIdentities).values({ userId: sam, issuer: ISSUER, subject: "sub-sam" }));
    const claims = { issuer: ISSUER, subject: "sub-sam", clientId: "host-a", scopes: ["cerebro:read"], authTime: new Date(Date.now() - 60_000) };
    await authenticateOAuthGrant(w.h.db, claims);

    await removeMembership(w.h.db, w.ctx("riley"), { userId: sam });
    await reactivate(sam);
    await expectCode(authenticateOAuthGrant(w.h.db, claims), "unauthenticated");

    // A fresh authorization after the removal works again.
    const fresh = await authenticateOAuthGrant(w.h.db, { ...claims, authTime: new Date(Date.now() + 1_000) });
    expect(fresh.userId).toBe(sam);
    const rows = await sys(w, (tx) => tx.select().from(integrationConnections).where(eq(integrationConnections.userId, sam)));
    expect(rows.map((r) => r.status).sort()).toEqual(["active", "revoked"]);
  });
});
