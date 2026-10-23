/**
 * Regression tests for defects found in the security review of the domain
 * layer. Each test failed before its fix.
 */
import { retrievalChunks } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeAudience, compareRevisions, getRevisionDocument, grantAccess } from "../../src/briefings/index";
import { askQuestion, listMyFeedback, submitFeedback } from "../../src/engagement/index";
import { runIdempotent } from "../../src/integration/index";
import { acceptInvitation, changeMemberRole, createInvitation, removeMembership } from "../../src/org/index";
import { createPreview, publishBriefing, withdrawPublication } from "../../src/publication/index";
import { makePublished } from "../../src/publication/test-utils";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { drain, expectCode, NRR_QUESTION, sys } from "./helpers";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  await w.h.close();
});

describe("withdrawn content is not served through Q&A or retrieval", () => {
  it("collaborators cannot ask about a withdrawn revision and its retrieval chunks are removed", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const ok = await askQuestion(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, question: NRR_QUESTION });
    expect(ok.status).toBe("answered");

    await withdrawPublication(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    await expectCode(
      askQuestion(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, revisionNumber: 1, question: NRR_QUESTION }),
      "not_found",
    );
    const chunks = await sys(w, (tx) => tx.select().from(retrievalChunks).where(eq(retrievalChunks.revisionId, p.pub.revisionId)));
    expect(chunks).toHaveLength(0);
  });

  it("the indexer does not build a reader corpus for a revision withdrawn before indexing", async () => {
    const p = await makePublished(w, { user: "maya" });
    await withdrawPublication(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    await drain(w);
    const chunks = await sys(w, (tx) => tx.select().from(retrievalChunks).where(eq(retrievalChunks.revisionId, p.pub.revisionId)));
    expect(chunks).toHaveLength(0);
  });
});

describe("listMyFeedback after access loss", () => {
  it("does not return revision content (block excerpts, section titles) the reader can no longer read", async () => {
    const p = await makePublished(w, { user: "maya" });
    await submitFeedback(w.h.db, w.ctx("alex"), {
      briefingId: p.briefingId,
      revisionNumber: 1,
      blockId: "blk_rec_narrative",
      type: "comment",
      text: "My own words.",
    });
    const before = await listMyFeedback(w.h.db, w.ctx("alex"), p.briefingId);
    expect(before[0]!.block!.excerpt.length).toBeGreaterThan(0);

    await changeAudience(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, audience: { visibility: "restricted" } });
    const after = await listMyFeedback(w.h.db, w.ctx("alex"), p.briefingId);
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toBe("My own words.");
    expect(after[0]!.block).toMatchObject({ blockId: "blk_rec_narrative", excerpt: "", sectionTitle: null, presentInCurrentRevision: false });
    expect(JSON.stringify(after)).not.toContain(before[0]!.block!.excerpt.slice(0, 40));
  });
});

describe("invitations recheck the inviter's current authority at acceptance", () => {
  it("a membership invitation from a demoted admin cannot be accepted", async () => {
    await changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.alex, role: "admin" });
    const { token } = await createInvitation(w.h.db, w.ctx("alex"), { kind: "membership", email: "casey@partner.example" });
    await changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.alex, role: "member" });
    await expectCode(acceptInvitation(w.h.db, { token, userId: w.seed.users.casey }), "forbidden");
  });

  it("a briefing invitation from a user who lost manage_access cannot be accepted", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted" } });
    const { token } = await createInvitation(w.h.db, w.ctx("maya"), {
      kind: "briefing",
      email: "casey@partner.example",
      briefingId: p.briefingId,
    });
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.maya });
    await expectCode(acceptInvitation(w.h.db, { token, userId: w.seed.users.casey }), "forbidden");
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: p.briefingId }), "not_found");
  });
});

describe("removing a company membership ends grant-based access", () => {
  it("a removed member's reader grants stop working on the next operation", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted", readerUserIds: [w.seed.users.sam] } });
    await getRevisionDocument(w.h.db, w.ctx("sam"), { briefingId: p.briefingId });
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("sam"), { briefingId: p.briefingId }), "not_found");
    // An explicit re-grant afterwards (as an external reader) is honoured.
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, userId: w.seed.users.sam, role: "reader" });
    await getRevisionDocument(w.h.db, w.ctx("sam"), { briefingId: p.briefingId });
  });
});

describe("publication race: a preview is bound to the publication it was reviewed against", () => {
  it("a second preview of the same draft is stale once another publication happened", async () => {
    const p = await makePublished(w, { user: "riley" });
    await grantAccess(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, userId: w.seed.users.jordan, role: "publisher" });
    const mine = await createPreview(w.h.db, w.ctx("riley"), { briefingId: p.briefingId });
    const theirs = await createPreview(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId });
    await publishBriefing(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, previewId: mine.previewId });
    const e = await expectCode(
      publishBriefing(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, previewId: theirs.previewId }),
      "stale_preview",
    );
    expect((e.details as { reasons: string[] }).reasons).toContain("publication");
  });

  it("withdrawal after preview makes the preview stale", async () => {
    const p = await makePublished(w, { user: "riley" });
    const preview = await createPreview(w.h.db, w.ctx("riley"), { briefingId: p.briefingId });
    await withdrawPublication(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    await expectCode(publishBriefing(w.h.db, w.ctx("riley"), { briefingId: p.briefingId, previewId: preview.previewId }), "stale_preview");
  });
});

describe("no existence oracle", () => {
  it("compareRevisions gives the same error for an inaccessible briefing and a missing one", async () => {
    const p = await makePublished(w, { user: "maya", audience: { visibility: "restricted" } });
    const a = await expectCode(compareRevisions(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, from: 1, to: 1 }), "not_found");
    const b = await expectCode(
      compareRevisions(w.h.db, w.ctx("jordan"), { briefingId: "00000000-0000-4000-8000-000000000000", from: 1, to: 1 }),
      "not_found",
    );
    expect(a.message).toBe(b.message);
  });
});

describe("idempotent replay re-authorizes cached results", () => {
  it("a replay for a briefing the caller can no longer access is not_found", async () => {
    const p = await makePublished(w, { user: "maya" });
    const run = () =>
      runIdempotent(w.h.db, w.ctx("alex", "acme", "mcp"), { action: "test.op", idempotencyKey: "k1", input: { a: 1 } }, async () => ({
        resultRef: { type: "briefing", id: p.briefingId },
        result: { ok: true },
      }));
    await run();
    expect((await run()).replayed).toBe(true);
    await changeAudience(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, audience: { visibility: "restricted" } });
    await expectCode(run(), "not_found");
  });
});
