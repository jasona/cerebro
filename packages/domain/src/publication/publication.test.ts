import {
  auditEvents,
  briefingRevisions,
  briefings,
  jobs,
  publicationPreviews,
  publications,
  revisionEvidence,
  withAuthContext,
  withSystemContext,
} from "@cerebro/database";
import { BriefingDocument, markdownToDocument, sequentialIds, strategyBriefing, teamPlanBriefing } from "@cerebro/briefing-schema";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { createTestWorld, type TestWorld } from "../testing";
import {
  changeAudience,
  getBriefingMeta,
  getDraft,
  getRevisionDocument,
  grantAccess,
  listRevisions,
  moveBriefingHome,
  setEvidenceStatus,
} from "../briefings/index";
import {
  createPreview,
  createShareLink,
  listShareLinks,
  publishBriefing,
  resolveShareLink,
  revokeShareLink,
  withdrawPublication,
} from "./index";
import { editHeadline, makeDraft, makePublished } from "./test-utils";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

async function expectCode(p: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error(`expected DomainError ${code}`);
}

const sys = <T>(fn: Parameters<typeof withSystemContext<T>>[1]) => withSystemContext(w.h.db, fn);

describe("publish", () => {
  it("happy path: revision, approved evidence, publication, pointer, audit, job", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: d.version });
    expect(preview.canPublish).toBe(true);
    expect(preview.audience.visibility).toBe("company");
    expect(preview.evidence.approved).toHaveLength(strategyBriefing.evidence.length);
    expect(preview.changeSummary).toEqual(["First publication."]);
    expect(preview.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    const pub = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId, idempotencyKey: "k1" });
    expect(pub.revisionNumber).toBe(1);
    expect(pub.replayed).toBe(false);
    expect(pub.canonicalPath).toBe(`/c/acme/b/${d.slug}`);
    expect(pub.pinnedPath).toBe(`/c/acme/b/${d.slug}/v/1`);

    await sys(async (tx) => {
      const [b] = await tx.select().from(briefings).where(eq(briefings.id, d.briefingId));
      expect(b!.currentPublicationId).toBe(pub.publicationId);
      const ev = await tx.select().from(revisionEvidence).where(eq(revisionEvidence.revisionId, pub.revisionId));
      expect(ev.map((e) => e.evidenceKey).sort()).toEqual(strategyBriefing.evidence.map((e) => e.id).sort());
      expect(ev.every((e) => /^[0-9a-f]{64}$/.test(e.excerptHash))).toBe(true);
      const [audit] = await tx.select().from(auditEvents).where(eq(auditEvents.action, "briefing.published"));
      expect(audit!.revisionId).toBe(pub.revisionId);
      expect(audit!.metadata).toMatchObject({ operationRef: "k1", previewId: preview.previewId });
      const [job] = await tx.select().from(jobs).where(eq(jobs.kind, "index_revision"));
      expect(job!.dedupeKey).toBe(`index_revision:${w.seed.orgs.acme.id}:${pub.revisionId}`);
      const [pv] = await tx.select().from(publicationPreviews).where(eq(publicationPreviews.id, preview.previewId));
      expect(pv!.publicationId).toBe(pub.publicationId);
    });
    const read = await getRevisionDocument(w.h.db, w.ctx("sam"), { briefingId: d.briefingId });
    expect(read.revision.publicationId).toBe(pub.publicationId);
  });

  it("requires publish capability: editors and readers cannot preview or publish", async () => {
    const d = await makeDraft(w);
    await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.maya, role: "editor" });
    await expectCode(createPreview(w.h.db, w.ctx("maya"), { briefingId: d.briefingId }), "forbidden");
    await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.alex, role: "publisher" });
    const p = await createPreview(w.h.db, w.ctx("alex"), { briefingId: d.briefingId });
    // A preview is bound to its actor: Riley cannot publish Alex's preview.
    await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p.previewId }), "not_found");
    const pub = await publishBriefing(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, previewId: p.previewId });
    expect(pub.revisionNumber).toBe(1);
  });

  it("published revisions are immutable at the database", async () => {
    const d = await makePublished(w);
    await expect(
      withAuthContext(w.h.db, d.ctx, (tx) =>
        tx.update(briefingRevisions).set({ contentHash: "tampered" }).where(eq(briefingRevisions.id, d.pub.revisionId)),
      ),
    ).rejects.toThrow();
    // Even the owner connection is stopped by the trigger.
    await expect(
      sys((tx) => tx.update(briefingRevisions).set({ contentHash: "tampered" }).where(eq(briefingRevisions.id, d.pub.revisionId))),
    ).rejects.toThrow();
    await expect(
      sys((tx) => tx.update(revisionEvidence).set({ excerpt: "tampered" }).where(eq(revisionEvidence.revisionId, d.pub.revisionId))),
    ).rejects.toThrow();
    const [r] = await sys((tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.id, d.pub.revisionId)));
    expect(r!.contentHash).not.toBe("tampered");
  });

  it("candidate and excluded evidence never enter revision_evidence; dropped refs are listed", async () => {
    const d = await makeDraft(w, { approve: false });
    await setEvidenceStatus(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: d.version, evidenceId: "ev_cohort_q3", status: "approved" });
    await setEvidenceStatus(w.h.db, d.ctx, {
      briefingId: d.briefingId,
      expectedVersion: d.version + 1,
      evidenceId: "ev_support_capacity",
      status: "excluded",
    });
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(preview.evidence.approved.map((e) => e.id)).toEqual(["ev_cohort_q3"]);
    expect(preview.evidence.excluded.map((e) => e.id)).toEqual(["ev_support_capacity"]);
    expect(preview.evidence.candidates.length).toBe(strategyBriefing.evidence.length - 2);
    expect(preview.droppedRefs.length).toBeGreaterThan(0);
    expect(preview.droppedRefs.every((r) => r.evidenceId !== "ev_cohort_q3")).toBe(true);
    expect(preview.document.evidence.map((e) => e.id)).toEqual(["ev_cohort_q3"]);

    const pub = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId });
    const ev = await sys((tx) => tx.select().from(revisionEvidence).where(eq(revisionEvidence.revisionId, pub.revisionId)));
    expect(ev.map((e) => e.evidenceKey)).toEqual(["ev_cohort_q3"]);
    const read = await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId });
    expect(read.document.evidence.map((e) => e.id)).toEqual(["ev_cohort_q3"]);
    const refs = read.document.sections.flatMap((s) => s.blocks.flatMap((b) => b.evidenceRefs.map((r) => r.evidenceId)));
    expect(new Set(refs)).toEqual(new Set(["ev_cohort_q3"]));
  });

  it("zero-evidence publication is allowed with a warning", async () => {
    const { document } = markdownToDocument(
      "# Zero evidence\n\nWe will try a small change.\n\n## Why now\n\nTiming is good.\n\nDecision: Approve the small change.",
      { ids: sequentialIds() },
    );
    const d = await makeDraft(w, { document });
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(preview.issues.some((i) => i.code === "no_approved_evidence" && i.severity === "warning")).toBe(true);
    expect(preview.canPublish).toBe(true);
    const pub = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId });
    const read = await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId });
    expect(read.noEvidence).toBe(true);
    expect(read.revision.revisionId).toBe(pub.revisionId);
  });

  it("errors block publication and leave the previous publication intact", async () => {
    const d = await makePublished(w);
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    const broken = BriefingDocument.parse({ ...draft.document, sections: [{ ...draft.document.sections[0]!, blocks: [] }] });
    await (await import("../briefings/index")).updateDraft(w.h.db, d.ctx, {
      briefingId: d.briefingId,
      expectedVersion: draft.lockVersion,
      document: broken,
    });
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(preview.canPublish).toBe(false);
    await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId }), "validation");
    const meta = await getBriefingMeta(w.h.db, d.ctx, d.briefingId);
    expect(meta.currentPublication?.publicationId).toBe(d.pub.publicationId);
    const [{ n }] = (await sys((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(briefingRevisions).where(eq(briefingRevisions.briefingId, d.briefingId)),
    )) as [{ n: number }];
    expect(n).toBe(1);
  });
});

describe("preview binding", () => {
  it("is stale after a draft edit", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await editHeadline(w, "riley", d.briefingId, "Changed after preview.");
    const err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId }), "stale_preview");
    expect(err.details?.reasons).toEqual(expect.arrayContaining(["content", "draft_version"]));
  });

  it("is stale after an evidence approval change", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await setEvidenceStatus(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: d.version, evidenceId: "ev_cohort_q3", status: "excluded" });
    const err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId }), "stale_preview");
    expect(err.details?.reasons).toContain("evidence");
  });

  it("is stale after an audience change, including a new named reader", async () => {
    const d = await makeDraft(w);
    const p1 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await changeAudience(w.h.db, d.ctx, { briefingId: d.briefingId, audience: { visibility: "restricted" } });
    let err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p1.previewId }), "stale_preview");
    expect(err.details?.reasons).toEqual(["audience"]);

    const p2 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.casey, role: "reader" });
    err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p2.previewId }), "stale_preview");
    expect(err.details?.reasons).toEqual(["audience"]);

    const p3 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(p3.audience.namedReaders?.map((r) => r.userId)).toEqual([w.seed.users.casey]);
    await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p3.previewId });
    expect((await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId })).revision.revisionNumber).toBe(1);
    await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId }), "not_found");
  });

  it("is stale after a home change", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await moveBriefingHome(w.h.db, d.ctx, { briefingId: d.briefingId, home: { departmentId: w.seed.orgs.acme.departments.product } });
    const err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId }), "stale_preview");
    expect(err.details?.reasons).toEqual(["home"]);
  });

  it("rejects an expired preview", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await sys((tx) =>
      tx.update(publicationPreviews).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(publicationPreviews.id, preview.previewId)),
    );
    const err = await expectCode(publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId }), "stale_preview");
    expect(err.details?.reasons).toEqual(["expired"]);
  });

  it("rechecks publish permission at publication time", async () => {
    const d = await makeDraft(w);
    const g = await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.alex, role: "publisher" });
    const p = await createPreview(w.h.db, w.ctx("alex"), { briefingId: d.briefingId });
    const { revokeGrant } = await import("../briefings/index");
    await revokeGrant(w.h.db, d.ctx, { briefingId: d.briefingId, grantId: g.grantId });
    await expectCode(publishBriefing(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, previewId: p.previewId }), "not_found");
  });
});

describe("idempotency and races", () => {
  it("retrying with the same preview returns the same publication", async () => {
    const d = await makePublished(w);
    const again = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: d.preview.previewId });
    expect(again.publicationId).toBe(d.pub.publicationId);
    expect(again.revisionNumber).toBe(1);
    expect(again.replayed).toBe(true);
  });

  it("concurrent publish attempts with one preview produce one revision", async () => {
    const d = await makeDraft(w);
    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId })),
    );
    expect(new Set(results.map((r) => r.publicationId)).size).toBe(1);
    const revs = await sys((tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.briefingId, d.briefingId)));
    expect(revs).toHaveLength(1);
    const pubs = await sys((tx) => tx.select().from(publications).where(eq(publications.briefingId, d.briefingId)));
    expect(pubs).toHaveLength(1);
  });
});

describe("withdrawal", () => {
  it("clears the current pointer and withdraws earlier revisions too (D16); no auto-promotion", async () => {
    const d = await makePublished(w);
    await editHeadline(w, "riley", d.briefingId, "Second revision headline.");
    const p2 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    const pub2 = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p2.previewId });

    const res = await withdrawPublication(w.h.db, d.ctx, { briefingId: d.briefingId, publicationId: pub2.publicationId });
    expect(res.clearedCurrent).toBe(true);
    expect(res.alsoWithdrawn).toBe(1);
    const [b] = await sys((tx) => tx.select().from(briefings).where(eq(briefings.id, d.briefingId)));
    expect(b!.currentPublicationId).toBeNull();

    const err = await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId }), "not_found");
    expect(err.details).toEqual({ reason: "withdrawn" });
    expect(JSON.stringify(err)).not.toContain("Second revision");
    // D16: withdrawing the brief withdraws revision 1 as well; pinned links show the withdrawn state, without content.
    const pinned1 = await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, revisionNumber: 1 }), "not_found");
    expect(pinned1.details).toEqual({ reason: "withdrawn" });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, revisionNumber: 2 }), "not_found");
    const audits = await sys((tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, d.briefingId), eq(auditEvents.action, "publication.withdrawn"))));
    expect(audits).toHaveLength(2);
    // Outsiders learn nothing.
    const outsider = await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId }), "not_found");
    expect(outsider.details).toBeUndefined();
    // Withdrawal is idempotent and irreversible.
    const again = await withdrawPublication(w.h.db, d.ctx, { briefingId: d.briefingId, publicationId: pub2.publicationId });
    expect(again.changed).toBe(false);
    await expect(
      withAuthContext(w.h.db, d.ctx, (tx) => tx.update(publications).set({ withdrawnAt: null }).where(eq(publications.id, pub2.publicationId))),
    ).rejects.toThrow();
    // Collaborators see the withdrawn flag in history; readers do not see withdrawn entries.
    expect((await listRevisions(w.h.db, d.ctx, d.briefingId)).map((r) => [r.revisionNumber, r.withdrawn])).toEqual([
      [2, true],
      [1, true],
    ]);
    // Readers without a current publication cannot list revisions at all.
    await expectCode(listRevisions(w.h.db, w.ctx("alex"), d.briefingId), "not_found");
    // Only withdraw-capable roles can withdraw.
    await expectCode(withdrawPublication(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, publicationId: d.pub.publicationId }), "not_found");
  });

  it("withdrawing an older, non-current publication leaves the current one alone; republishing after withdrawal works", async () => {
    const d = await makePublished(w);
    await editHeadline(w, "riley", d.briefingId, "Second revision headline.");
    const p2 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    const pub2 = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p2.previewId });
    const older = await withdrawPublication(w.h.db, d.ctx, { briefingId: d.briefingId, publicationId: d.pub.publicationId });
    expect([older.clearedCurrent, older.alsoWithdrawn]).toEqual([false, 0]);
    expect((await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId })).revision.revisionNumber).toBe(2);

    await withdrawPublication(w.h.db, d.ctx, { briefingId: d.briefingId, publicationId: pub2.publicationId });
    await editHeadline(w, "riley", d.briefingId, "Third revision headline.");
    const p3 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p3.previewId });
    const current = await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId });
    expect(current.revision.revisionNumber).toBe(3);
    await expectCode(getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, revisionNumber: 1 }), "not_found");
  });
});

describe("share links", () => {
  it("is stored hashed, returned once, and resolves only for authorized users", async () => {
    const d = await makePublished(w, { user: "maya", document: teamPlanBriefing, audience: { visibility: "team", teamId: w.seed.orgs.acme.teams.platform } });
    const link = await createShareLink(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(link.path).toBe(`/s/${link.token}`);
    const listed = await listShareLinks(w.h.db, d.ctx, d.briefingId);
    expect(JSON.stringify(listed)).not.toContain(link.token);

    // Alex is on Platform: resolves.
    expect(await resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.alex })).toEqual({
      orgId: w.seed.orgs.acme.id,
      orgSlug: "acme",
      briefingSlug: d.slug,
    });
    // Priya (Product department member, not on Platform) and Casey: not_found without reason.
    for (const u of ["priya", "casey", "taylor"] as const) {
      const err = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users[u] }), "not_found");
      expect(err.details).toBeUndefined();
    }
    await expectCode(resolveShareLink(w.h.db, { token: link.token }), "unauthenticated");
    await expectCode(resolveShareLink(w.h.db, { token: "x".repeat(43), userId: w.seed.users.alex }), "not_found");

    await revokeShareLink(w.h.db, d.ctx, { briefingId: d.briefingId, shareLinkId: link.shareLinkId });
    const err = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.alex }), "not_found");
    expect(err.details).toEqual({ reason: "revoked" });
    // Revoking the link does not affect direct access.
    expect((await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: d.briefingId })).revision.revisionNumber).toBe(1);
  });

  it("expired links resolve to not_found with a reason", async () => {
    const d = await makePublished(w);
    const link = await createShareLink(w.h.db, d.ctx, { briefingId: d.briefingId, expiresAt: new Date(Date.now() + 60_000) });
    await sys((tx) => tx.execute(sql`update share_links set expires_at = now() - interval '1 second' where id = ${link.shareLinkId}`));
    const err = await expectCode(resolveShareLink(w.h.db, { token: link.token, userId: w.seed.users.alex }), "not_found");
    expect(err.details).toEqual({ reason: "expired" });
  });

  it("a pinned link never grants future revisions", async () => {
    const d = await makePublished(w, { audience: { visibility: "restricted" } });
    await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.casey, role: "reader", revisionNumber: 1 });
    const pinned = await createShareLink(w.h.db, d.ctx, { briefingId: d.briefingId, pinnedRevisionNumber: 1 });
    const stable = await createShareLink(w.h.db, d.ctx, { briefingId: d.briefingId });

    await editHeadline(w, "riley", d.briefingId, "Revision two.");
    const p2 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p2.previewId });

    const r = await resolveShareLink(w.h.db, { token: pinned.token, userId: w.seed.users.casey });
    expect(r.revisionNumber).toBe(1);
    expect((await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId, revisionNumber: 1 })).revision.revisionNumber).toBe(1);
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId, revisionNumber: 2 }), "not_found");
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId }), "not_found");
    // The stable link now points at revision 2, which Casey's scoped grant does not cover.
    await expectCode(resolveShareLink(w.h.db, { token: stable.token, userId: w.seed.users.casey }), "not_found");
    // Riley (owner) resolves the stable link to the latest.
    expect((await resolveShareLink(w.h.db, { token: stable.token, userId: w.seed.users.riley })).revisionNumber).toBeUndefined();
  });

  it("only manage_access can create links", async () => {
    const d = await makePublished(w);
    await expectCode(createShareLink(w.h.db, w.ctx("alex"), { briefingId: d.briefingId }), "forbidden");
    await expectCode(createShareLink(w.h.db, w.ctx("taylor", "globex"), { briefingId: d.briefingId }), "not_found");
  });
});
