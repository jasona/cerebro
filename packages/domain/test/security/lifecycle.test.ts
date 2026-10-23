/**
 * Security regression suite, part 2: private Q&A, publication binding and
 * races, revision-scoped grants and links, withdrawal, membership/connection
 * revocation and background jobs rechecking current access.
 */
import {
  briefingRevisions,
  engagementInsights,
  jobs,
  publicationPreviews,
  publications,
  retrievalChunks,
  revisionEvidence,
  sourceChunks,
  withAuthContext,
} from "@cerebro/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDraft, getRevisionDocument, grantAccess, listAccess, listRevisions, revokeGrant } from "../../src/briefings/index";
import {
  askQuestion,
  getAuthorFeedback,
  getEngagementSummary,
  getMyThreads,
  requestTopicSummary,
} from "../../src/engagement/index";
import { authenticateConnectionToken, createConnectionToken, revokeConnection } from "../../src/integration/index";
import { listLibrary } from "../../src/library/index";
import { removeMembership, removeTeamMember } from "../../src/org/index";
import {
  createPreview,
  createShareLink,
  publishBriefing,
  resolveShareLink,
  revokeShareLink,
  withdrawPublication,
} from "../../src/publication/index";
import { editHeadline, makePublished } from "../../src/publication/test-utils";
import { addSource } from "../../src/sources/index";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { drain, expectCode, NRR_QUESTION, sys } from "./helpers";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  await w.h.close();
});

async function republish(user: "maya" | "riley", briefingId: string, headline: string) {
  await editHeadline(w, user, briefingId, headline);
  const pv = await createPreview(w.h.db, w.ctx(user), { briefingId });
  return publishBriefing(w.h.db, w.ctx(user), { briefingId, previewId: pv.previewId });
}

const asApp = <T>(user: "maya", fn: Parameters<typeof withAuthContext<T>>[2]) =>
  withAuthContext(w.h.db, { userId: w.seed.users[user], organizationId: w.seed.orgs.acme.id }, fn);

// ---------------------------------------------------------------------------
// 4. Reader Q&A: exact revision, private threads
// ---------------------------------------------------------------------------

describe("reader Q&A", () => {
  it("threads are private to the asker: not the owner, an admin or another reader", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const SECRET_Q = "Is the retention figure for mid-market reliable enough to bet on?";
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: SECRET_Q });
    expect(res.threadId).toBeTruthy();

    for (const u of ["maya", "riley", "jordan"] as const) {
      const threads = await getMyThreads(w.h.db, w.ctx(u), p.briefingId);
      expect(threads.map((t) => t.threadId), u).not.toContain(res.threadId);
      expect(JSON.stringify(threads)).not.toContain("bet on");
      await expectCode(askQuestion(w.h.db, w.ctx(u), { briefingId: p.briefingId, question: "x", threadId: res.threadId! }), "not_found");
    }
    const author = JSON.stringify([
      await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: p.briefingId }),
      await getEngagementSummary(w.h.db, w.ctx("maya"), p.briefingId),
    ]);
    expect(author).not.toContain("bet on");
    expect(author).not.toContain(w.seed.users.alex);
  });

  it("answers bind to the exact requested revision, never a newer or older one", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const r1 = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    await republish("maya", p.briefingId, "A sharper headline for revision two");
    // Revision 2 not yet indexed: preparing, no fallback to revision 1.
    const prep = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    expect(prep).toMatchObject({ status: "preparing", revisionNumber: 2 });
    await drain(w);
    const r2 = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    expect(r2.revisionNumber).toBe(2);
    await expectCode(
      askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION, threadId: r1.threadId! }),
      "conflict",
    );
    const pinned = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, revisionNumber: 1, question: NRR_QUESTION, threadId: r1.threadId! });
    expect(pinned.revisionNumber).toBe(1);

    // Every stored citation belongs to its message's revision and that revision's evidence.
    const bad = await sys(w, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from answer_citations c
        join qa_messages m on m.organization_id = c.organization_id and m.id = c.message_id
        left join revision_evidence e on e.organization_id = c.organization_id and e.id = c.evidence_id
        where c.revision_id <> m.revision_id or (c.evidence_id is not null and e.revision_id <> m.revision_id)`),
    );
    expect(bad.rows[0]!.n).toBe(0);
  });

  it("the reader corpus is exactly the revision's blocks plus approved evidence", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const chunks = await sys(w, (tx) => tx.select().from(retrievalChunks));
    expect(new Set(chunks.map((c) => c.revisionId))).toEqual(new Set([p.pub.revisionId]));
    const ev = await sys(w, (tx) => tx.select({ id: revisionEvidence.id }).from(revisionEvidence).where(eq(revisionEvidence.revisionId, p.pub.revisionId)));
    const allowed = new Set(ev.map((e) => e.id));
    for (const c of chunks) {
      if (c.kind === "evidence") expect(allowed.has(c.evidenceId!)).toBe(true);
      else expect(c.kind).toBe("block");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Publication binding, races, idempotency, immutability
// ---------------------------------------------------------------------------

describe("publication", () => {
  it("a preview is bound to its actor", async () => {
    const p = await makePublished(w, { user: "riley" });
    await grantAccess(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, userId: w.seed.users.jordan, role: "publisher" });
    await editHeadline(w, "riley", p.briefingId, "Changed");
    const pv = await createPreview(w.h.db, w.ctx("riley"), { briefingId: p.briefingId });
    await expectCode(publishBriefing(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, previewId: pv.previewId }), "not_found");
  });

  it("publish permission is rechecked at publication, not taken from the preview", async () => {
    const p = await makePublished(w, { user: "riley" });
    const g = await grantAccess(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, userId: w.seed.users.jordan, role: "publisher" });
    await editHeadline(w, "riley", p.briefingId, "Changed");
    const pv = await createPreview(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId });
    await revokeGrant(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, grantId: g.grantId });
    await expectCode(publishBriefing(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, previewId: pv.previewId }), "forbidden");
  });

  it("named-reader, evidence and expiry changes make a preview stale", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted" } });
    const a = await createPreview(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.casey, role: "reader" });
    const e1 = await expectCode(publishBriefing(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, previewId: a.previewId }), "stale_preview");
    expect((e1.details as { reasons: string[] }).reasons).toContain("audience");

    const b = await createPreview(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    await sys(w, (tx) => tx.update(publicationPreviews).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(publicationPreviews.id, b.previewId)));
    await expectCode(publishBriefing(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, previewId: b.previewId }), "stale_preview");
  });

  it("concurrent publishes of one preview produce exactly one revision; replays return it", async () => {
    const p = await makePublished(w, { user: "maya" });
    await editHeadline(w, "maya", p.briefingId, "Second");
    const pv = await createPreview(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    const results = await Promise.allSettled([1, 2, 3].map(() => publishBriefing(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, previewId: pv.previewId })));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof publishBriefing>>> => r.status === "fulfilled");
    expect(new Set(ok.map((r) => r.value.revisionId)).size).toBe(1);
    const revs = await sys(w, (tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.briefingId, p.briefingId)));
    expect(revs).toHaveLength(2);
  });

  it("revisions, evidence and publications are immutable for the runtime role", async () => {
    const p = await makePublished(w, { user: "maya" });
    await expect(asApp("maya", (tx) => tx.update(briefingRevisions).set({ number: 9 }).where(eq(briefingRevisions.id, p.pub.revisionId)))).rejects.toThrow();
    await expect(asApp("maya", (tx) => tx.delete(revisionEvidence).where(eq(revisionEvidence.revisionId, p.pub.revisionId)))).rejects.toThrow();
    await expect(asApp("maya", (tx) => tx.update(publications).set({ changeSummary: "rewritten" }).where(eq(publications.id, p.pub.publicationId)))).rejects.toThrow();
    await withdrawPublication(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    await expect(asApp("maya", (tx) => tx.update(publications).set({ withdrawnAt: null }).where(eq(publications.id, p.pub.publicationId)))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Revision-scoped grants, pinned links, withdrawal
// ---------------------------------------------------------------------------

describe("revision scope and links", () => {
  it("a revision-scoped grant never reaches newer revisions", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted" } });
    await drain(w);
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.casey, role: "reader", revisionNumber: 1 });
    const casey = w.ctx("casey");
    expect((await getRevisionDocument(w.h.db, casey, { briefingId: p.briefingId })).revision.revisionNumber).toBe(1);

    await republish("maya", p.briefingId, "Revision two headline");
    await drain(w);
    await expectCode(getRevisionDocument(w.h.db, casey, { briefingId: p.briefingId }), "not_found");
    await expectCode(getRevisionDocument(w.h.db, casey, { briefingId: p.briefingId, revisionNumber: 2 }), "not_found");
    expect((await getRevisionDocument(w.h.db, casey, { briefingId: p.briefingId, revisionNumber: 1 })).revision.revisionNumber).toBe(1);
    await expectCode(askQuestion(w.h.db, casey, { briefingId: p.briefingId, question: NRR_QUESTION }), "not_found");
    await expectCode(askQuestion(w.h.db, casey, { briefingId: p.briefingId, revisionNumber: 2, question: NRR_QUESTION }), "not_found");
    expect((await askQuestion(w.h.db, casey, { briefingId: p.briefingId, revisionNumber: 1, question: NRR_QUESTION })).revisionNumber).toBe(1);
    await expectCode(listRevisions(w.h.db, casey, p.briefingId), "not_found");

    // Pinned link to revision 1 resolves to 1 only; the stable link does not resolve.
    const pinned = await createShareLink(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, pinnedRevisionNumber: 1 });
    const stable = await createShareLink(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    expect(await resolveShareLink(w.h.db, { token: pinned.token, userId: casey.userId })).toMatchObject({ revisionNumber: 1 });
    await expectCode(resolveShareLink(w.h.db, { token: stable.token, userId: casey.userId }), "not_found");
  });

  it("links are locators, not authorization; denied states disclose nothing to unrelated users", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted" } });
    const link = await createShareLink(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    const pinned = await createShareLink(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, pinnedRevisionNumber: 1 });
    for (const u of ["jordan", "riley", "taylor"] as const) {
      const e = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users[u] }), "not_found");
      expect(e.details).toBeUndefined();
    }
    await expectCode(resolveShareLink(w.h.db, { token: link.token }), "unauthenticated");

    const g = await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.casey, role: "reader" });
    expect(await resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.casey })).toMatchObject({ briefingSlug: expect.any(String) });
    await revokeShareLink(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, shareLinkId: link.shareLinkId });
    const r = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.casey }), "not_found");
    expect(r.details).toEqual({ reason: "revoked" });
    // Revoking the link leaves the direct grant intact.
    await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: p.briefingId });
    const jordanRevoked = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.jordan }), "not_found");
    expect(jordanRevoked.details).toBeUndefined();

    // Withdrawal: grantee sees a withdrawn state, unrelated users see nothing; no content anywhere.
    await withdrawPublication(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    const wd = await expectCode(resolveShareLink(w.h.db, { token: pinned.token, userId: w.seed.users.casey }), "not_found");
    expect(wd.details).toEqual({ reason: "withdrawn" });
    const doc = await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: p.briefingId }), "not_found");
    expect(doc.details).toEqual({ reason: "withdrawn" });
    const pin = await expectCode(getRevisionDocument(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, revisionNumber: 1 }), "not_found");
    expect(pin.details).toEqual({ reason: "withdrawn" });
    const un = await expectCode(getRevisionDocument(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId }), "not_found");
    expect(un.details).toBeUndefined();
    await revokeGrant(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, grantId: g.grantId });
    const gone = await expectCode(resolveShareLink(w.h.db, { token: pinned.token, userId: w.seed.users.casey }), "not_found");
    expect(gone.details).toBeUndefined();
  });

  it("withdrawal removes the briefing from discovery and Q&A immediately", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    await withdrawPublication(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    const lib = await listLibrary(w.h.db, w.ctx("jordan"), { limit: 100 });
    expect(lib.items.map((i) => i.briefingId)).not.toContain(p.briefingId);
    await expectCode(askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, question: NRR_QUESTION }), "not_found");
    await expectCode(askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, revisionNumber: 1, question: NRR_QUESTION }), "not_found");
    const chunks = await sys(w, (tx) => tx.select().from(retrievalChunks));
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Membership removal and connection revocation take effect next operation
// ---------------------------------------------------------------------------

describe("revocation", () => {
  it("removing a member ends collaborator access, library access and connection tokens", async () => {
    const p = await makePublished(w, { user: "maya" });
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.sam, role: "editor" });
    const { token } = await createConnectionToken(w.h.db, w.ctx("sam"), { label: "test" });
    const mcp = await authenticateConnectionToken(w.h.db, token);
    expect((await getDraft(w.h.db, mcp, p.briefingId)).briefingId).toBe(p.briefingId);

    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectCode(authenticateConnectionToken(w.h.db, token), "unauthenticated");
    // Even a context resolved before removal is denied on its next operation.
    await expectCode(getDraft(w.h.db, mcp, p.briefingId), "not_found");
    await expectCode(listLibrary(w.h.db, w.ctx("sam")), "not_found");
    await expectCode(getRevisionDocument(w.h.db, w.ctx("sam"), { briefingId: p.briefingId }), "not_found");
    expect((await listAccess(w.h.db, w.ctx("maya"), p.briefingId)).grants.map((g) => g.userId)).not.toContain(w.seed.users.sam);
  });

  it("a revoked connection token stops working on the next request", async () => {
    const { token, connection } = await createConnectionToken(w.h.db, w.ctx("maya"), { label: "test" });
    await authenticateConnectionToken(w.h.db, token);
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: connection.id });
    await expectCode(authenticateConnectionToken(w.h.db, token), "unauthenticated");
    await expectCode(createConnectionToken(w.h.db, w.ctx("maya", "acme", "mcp"), { label: "x" }), "forbidden");
  });

  it("team membership removal and grant revocation take effect immediately", async () => {
    const team = await makePublished(w, { user: "riley", audience: { visibility: "team", teamId: w.seed.orgs.acme.teams.platform! } });
    await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: team.briefingId });
    await removeTeamMember(w.h.db, w.ctx("riley"), { teamId: w.seed.orgs.acme.teams.platform!, userId: w.seed.users.alex });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: team.briefingId }), "not_found");

    const g = await grantAccess(w.h.db, w.ctx("riley"), { briefingId: team.briefingId, userId: w.seed.users.casey, role: "reader" });
    await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: team.briefingId });
    await revokeGrant(w.h.db, w.ctx("riley"), { briefingId: team.briefingId, grantId: g.grantId });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: team.briefingId }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// 10. Job handlers recheck current permissions
// ---------------------------------------------------------------------------

async function jobOf(kind: string) {
  const rows = await sys(w, (tx) => tx.select().from(jobs).where(eq(jobs.kind, kind)));
  return rows;
}

describe("background jobs", () => {
  it("extract_source fails closed when the requester lost access after enqueue", async () => {
    const src = await addSource(w.h.db, w.ctx("sam"), { kind: "text", text: "Sam's private notes.", origin: "manual" });
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await drain(w);
    const [job] = await jobOf("extract_source");
    expect(job).toMatchObject({ status: "failed", lastErrorCategory: "forbidden" });
    const chunks = await sys(w, (tx) => tx.select().from(sourceChunks).where(eq(sourceChunks.sourceId, src.sourceId)));
    expect(chunks).toHaveLength(0);
  });

  it("summarize_topics fails closed when the requester lost view_engagement", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const g = await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.alex, role: "editor" });
    await askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, question: NRR_QUESTION });
    await requestTopicSummary(w.h.db, w.ctx("alex"), p.briefingId);
    await revokeGrant(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, grantId: g.grantId });
    await drain(w);
    const [job] = await jobOf("summarize_topics");
    expect(job).toMatchObject({ status: "failed", lastErrorCategory: "forbidden" });
    expect(await sys(w, (tx) => tx.select().from(engagementInsights))).toHaveLength(0);
  });

  it("index_revision fails closed when the publisher is no longer a collaborator", async () => {
    const p = await makePublished(w, { user: "maya" });
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.maya });
    await drain(w);
    const [job] = await sys(w, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.kind, "index_revision"), sql`${jobs.payload}->>'revisionId' = ${p.pub.revisionId}`)),
    );
    expect(job).toMatchObject({ status: "failed", lastErrorCategory: "forbidden" });
    expect(await sys(w, (tx) => tx.select().from(retrievalChunks))).toHaveLength(0);
  });
});
