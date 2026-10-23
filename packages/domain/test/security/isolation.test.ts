/**
 * Security regression suite, part 1: access checks, discovery leaks,
 * draft-only fields, cross-tenant identifiers and admin non-access (D09).
 * Service level, runtime database role, seeded through real domain services.
 */
import { teamPlanBriefing } from "@cerebro/briefing-schema";
import { briefings, retrievalChunks, revisionEvidence, withAuthContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBriefingCapabilities } from "../../src/access/index";
import {
  changeAudience,
  compareRevisions,
  createBriefing,
  getBriefingMeta,
  getDraft,
  getRevisionDocument,
  grantAccess,
  listAccess,
  listRevisions,
  moveBriefingHome,
  revokeGrant,
  updateDraft,
} from "../../src/briefings/index";
import {
  askQuestion,
  getEngagementSummary,
  getMyThreads,
  listSubmittedFeedback,
  resolveFeedback,
  submitFeedback,
} from "../../src/engagement/index";
import { getOperation, runIdempotent } from "../../src/integration/index";
import { getFeaturedBriefing, listLibrary, listMyDrafts, searchBriefings } from "../../src/library/index";
import {
  addTeamMember,
  createInvitation,
  getCompanyBySlug,
  getOrgTree,
  getPeople,
  listInvitations,
  listMembers,
  previewTeamReparent,
} from "../../src/org/index";
import {
  createPreview,
  createShareLink,
  listShareLinks,
  publishBriefing,
  revokeShareLink,
  withdrawPublication,
} from "../../src/publication/index";
import { makeDraft, makePublished } from "../../src/publication/test-utils";
import { seedBriefings } from "../../src/seed/briefings";
import { addSource, createEvidenceFromChunk, getSourceExtraction } from "../../src/sources/index";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { drain, expectCode, NRR_QUESTION, sys } from "./helpers";

let w: TestWorld;
afterEach(async () => {
  await w?.h.close();
});

const RESTRICTED_TITLE = "Confidential reorganisation of Finance";

async function restrictedBrief(owner: "maya" | "riley" = "maya") {
  const p = await makePublished(w, { user: owner, audience: { visibility: "restricted" } });
  // Rename via a second publication so the restricted title is distinctive.
  const d = await getDraft(w.h.db, w.ctx(owner), p.briefingId);
  await updateDraft(w.h.db, w.ctx(owner), { briefingId: p.briefingId, expectedVersion: d.lockVersion, document: { ...d.document, title: RESTRICTED_TITLE } });
  const pv = await createPreview(w.h.db, w.ctx(owner), { briefingId: p.briefingId });
  await publishBriefing(w.h.db, w.ctx(owner), { briefingId: p.briefingId, previewId: pv.previewId });
  return p;
}

// ---------------------------------------------------------------------------
// 1 + 2. Discovery and lists never disclose inaccessible briefings
// ---------------------------------------------------------------------------

describe("discovery with seeded briefings", () => {
  let slugs: Record<string, string>;
  let ids: Record<string, string>;
  beforeEach(async () => {
    w = await createTestWorld();
    await seedBriefings(w.h, w.seed);
    const rows = await sys(w, (tx) =>
      tx.select({ id: briefings.id, slug: briefings.slug, title: briefings.title }).from(briefings),
    );
    slugs = Object.fromEntries(rows.map((r) => [r.title, r.slug]));
    ids = Object.fromEntries(rows.map((r) => [r.title, r.id]));
  });

  const TEAM = teamPlanBriefing.title;
  const FINANCE = "FY27 planning calendar and budget guardrails";
  const DRAFT = "Pricing simplification (working draft)";

  it("external readers cannot browse the company: library, search, featured, people, tree, drafts", async () => {
    const casey = w.ctx("casey");
    await expectCode(listLibrary(w.h.db, casey), "not_found");
    expect(await searchBriefings(w.h.db, casey, "upmarket")).toEqual({ items: [], total: 0 });
    expect(await getFeaturedBriefing(w.h.db, casey)).toBeNull();
    await expectCode(getPeople(w.h.db, casey), "not_found");
    await expectCode(getOrgTree(w.h.db, casey), "not_found");
    expect(await listMyDrafts(w.h.db, casey)).toEqual([]);
    await expectCode(getCompanyBySlug(w.h.db, w.seed.users.casey, "acme"), "not_found");
    // ...but can open the one briefing they were granted.
    const doc = await getRevisionDocument(w.h.db, casey, { briefingId: ids["Our next chapter: a focused move upmarket."]! });
    expect(doc.revision.revisionNumber).toBe(2);
    await expectCode(getRevisionDocument(w.h.db, casey, { slug: slugs[TEAM]! }), "not_found");
  });

  it("library rows, counts and search are filtered by audience", async () => {
    const jordan = w.ctx("jordan"); // Marketing + Sales: neither Platform nor Finance
    const page = await listLibrary(w.h.db, jordan, { limit: 100 });
    const titles = page.items.map((i) => i.title);
    expect(titles).not.toContain(TEAM);
    expect(titles).not.toContain(FINANCE);
    expect(titles).not.toContain(DRAFT);
    expect(page.total).toBe(page.items.length);
    for (const q of ["Platform readiness", "FY27 planning", "Pricing simplification"]) {
      const res = await searchBriefings(w.h.db, jordan, q);
      expect(res.items.map((i) => i.title), q).not.toContain(TEAM);
      expect(res.items.map((i) => i.title), q).not.toContain(FINANCE);
      expect(res.items.map((i) => i.title), q).not.toContain(DRAFT);
      expect(res.total).toBe(res.items.length);
    }
    // Team view of a team jordan is not in: no rows for the team-only brief.
    const team = await listLibrary(w.h.db, jordan, { scope: { kind: "team", teamId: w.seed.orgs.acme.teams.platform! } });
    expect(team.items.map((i) => i.title)).not.toContain(TEAM);

    const maya = await listLibrary(w.h.db, w.ctx("maya"), { limit: 100 });
    expect(maya.items.map((i) => i.title)).toContain(TEAM);
  });

  it("inaccessible briefings are indistinguishable from missing ones by slug", async () => {
    const jordan = w.ctx("jordan");
    const a = await expectCode(getBriefingMeta(w.h.db, jordan, { slug: slugs[TEAM]! }), "not_found");
    const b = await expectCode(getBriefingMeta(w.h.db, jordan, { slug: "no-such-brief" }), "not_found");
    expect(a.message).toBe(b.message);
    expect(a.details).toEqual(b.details);
    expect(JSON.stringify([a.message, a.details])).not.toContain("Platform readiness");
    const c = await expectCode(getRevisionDocument(w.h.db, jordan, { slug: slugs[DRAFT]! }), "not_found");
    const d = await expectCode(getRevisionDocument(w.h.db, jordan, { slug: "no-such-brief" }), "not_found");
    expect([c.message, c.details]).toEqual([d.message, d.details]);
  });

  it("company owner/admin get no implicit content access (D09)", async () => {
    // Riley is the Acme owner but not on the Platform team or in Finance.
    const riley = w.ctx("riley");
    const titles = (await listLibrary(w.h.db, riley, { limit: 100 })).items.map((i) => i.title);
    expect(titles).not.toContain(TEAM);
    expect(titles).not.toContain(FINANCE);
    await expectCode(getRevisionDocument(w.h.db, riley, { slug: slugs[TEAM]! }), "not_found");
    await expectCode(getDraft(w.h.db, riley, ids[TEAM]!), "not_found");
    await expectCode(listAccess(w.h.db, riley, ids[TEAM]!), "not_found");
    await expectCode(listSubmittedFeedback(w.h.db, riley, ids[TEAM]!), "not_found");
    await expectCode(getEngagementSummary(w.h.db, riley, ids[TEAM]!), "not_found");
    await expectCode(createShareLink(w.h.db, riley, { briefingId: ids[TEAM]! }), "not_found");
    await expectCode(listInvitations(w.h.db, riley, { briefingId: ids[TEAM]! }), "not_found");
    // On a company-visible brief owned by someone else, the owner role adds nothing beyond reading.
    const other = ids["Building a platform teams can trust"]!;
    const caps = await withAuthContext(w.h.db, { userId: riley.userId, organizationId: riley.organizationId }, (tx) =>
      getBriefingCapabilities(tx, riley, other),
    );
    expect([...caps].sort()).toEqual(["read", "view_evidence"]);
    await expectCode(getDraft(w.h.db, riley, other), "forbidden");
    await expectCode(listSubmittedFeedback(w.h.db, riley, other), "forbidden");
    await expectCode(listAccess(w.h.db, riley, other), "forbidden");
    // Riley's own private draft is invisible to everyone else.
    expect((await listMyDrafts(w.h.db, w.ctx("maya"))).map((d) => d.title)).not.toContain(DRAFT);
  });

  it("team reparent impact shows admins ids and counts only, never titles", async () => {
    const impact = await previewTeamReparent(w.h.db, w.ctx("riley"), {
      teamId: w.seed.orgs.acme.teams.planning!,
      newDepartmentId: w.seed.orgs.acme.departments.product!,
    });
    expect(JSON.stringify(impact)).not.toContain("FY27");
    expect(impact.homedBriefings.count).toBeGreaterThan(0);
  });

  it("members cannot use administrative listings", async () => {
    await expectCode(listMembers(w.h.db, w.ctx("maya")), "forbidden");
    await expectCode(listMembers(w.h.db, w.ctx("casey")), "not_found");
    await expectCode(listInvitations(w.h.db, w.ctx("maya")), "forbidden");
  });
});

// ---------------------------------------------------------------------------
// 3. Draft-only fields never reach readers, Q&A or the reader index
// ---------------------------------------------------------------------------

describe("draft-only fields and candidate evidence", () => {
  beforeEach(async () => {
    w = await createTestWorld();
  });

  const CANDIDATE = "Initial estimate: audit logging needs two sprints after SSO lands.";

  it("reader DTOs, revision evidence, Q&A corpus and comparisons exclude status, sourceRef and candidates", async () => {
    const src = await addSource(w.h.db, w.ctx("maya"), { kind: "text", text: "Private planning notes.", origin: "manual" });
    const doc = {
      ...teamPlanBriefing,
      evidence: teamPlanBriefing.evidence.map((e) => (e.id === "ev_tp_security_reviews" ? { ...e, sourceRef: { sourceId: src.sourceId } } : e)),
    };
    const p = await makePublished(w, { user: "maya", document: doc });
    await drain(w);

    const reader = await getRevisionDocument(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId });
    const json = JSON.stringify(reader);
    expect(json).not.toContain(CANDIDATE);
    expect(json).not.toContain("sourceRef");
    expect(json).not.toContain(src.sourceId);
    expect(json).not.toMatch(/"status"\s*:/);
    expect(reader.evidence.map((e) => e.id)).toEqual(["ev_tp_security_reviews"]);
    expect(Object.keys(reader.evidence[0]!).sort()).toEqual(["attribution", "excerpt", "id", "locator", "origin", "title"]);

    const ev = await sys(w, (tx) => tx.select().from(revisionEvidence).where(eq(revisionEvidence.revisionId, p.pub.revisionId)));
    expect(ev.map((e) => e.evidenceKey)).toEqual(["ev_tp_security_reviews"]);
    const chunks = await sys(w, (tx) => tx.select({ text: retrievalChunks.text }).from(retrievalChunks));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes("two sprints"))).toBe(false);
    expect(chunks.some((c) => c.text.includes("Private planning notes"))).toBe(false);

    const ans = await askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, question: "How many sprints does audit logging need after SSO?" });
    expect(JSON.stringify(ans)).not.toContain("two sprints");

    // Readers cannot diff against the draft; collaborators get the published projection only.
    await expectCode(compareRevisions(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, from: 1, to: "draft" }), "forbidden");
    const diff = await compareRevisions(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, from: 1, to: "draft" });
    expect(JSON.stringify(diff)).not.toContain(CANDIDATE);
    // Previews (which list candidates) need publish.
    await expectCode(createPreview(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId }), "forbidden");
    // Readers never get drafts.
    await expectCode(getDraft(w.h.db, w.ctx("jordan"), p.briefingId), "forbidden");
  });

  it("after first publication, draft title edits do not leak into reader metadata or the library", async () => {
    const p = await makePublished(w, { user: "maya" });
    const d = await getDraft(w.h.db, w.ctx("maya"), p.briefingId);
    await updateDraft(w.h.db, w.ctx("maya"), { briefingId: p.briefingId, expectedVersion: d.lockVersion, document: { ...d.document, title: "SECRET DRAFT TITLE" } });
    const meta = await getBriefingMeta(w.h.db, w.ctx("jordan"), p.briefingId);
    expect(meta.title).not.toContain("SECRET");
    expect(meta.draft).toBeUndefined();
    const lib = await listLibrary(w.h.db, w.ctx("jordan"));
    expect(JSON.stringify(lib)).not.toContain("SECRET");
    expect((await searchBriefings(w.h.db, w.ctx("jordan"), "SECRET DRAFT")).total).toBe(0);
  });

  it("restricted titles never appear in error messages or details", async () => {
    const p = await restrictedBrief();
    // Thunks, so each call starts only after the previous one settled: a
    // rejected promise created early would be reported as unhandled.
    for (const call of [
      () => getBriefingMeta(w.h.db, w.ctx("jordan"), p.briefingId),
      () => getRevisionDocument(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId }),
      () => listRevisions(w.h.db, w.ctx("jordan"), p.briefingId),
      () => askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, question: "What is this about?" }),
      () => submitFeedback(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, revisionNumber: 1, type: "comment", text: "x" }),
      () => getMyThreads(w.h.db, w.ctx("jordan"), p.briefingId),
    ]) {
      const e = await call().then(
        (v) => ({ message: "", details: v }),
        (err: { message: string; details?: unknown }) => err,
      );
      expect(JSON.stringify([e.message, e.details])).not.toContain("Confidential");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-tenant identifiers are rejected everywhere
// ---------------------------------------------------------------------------

describe("cross-tenant identifiers", () => {
  beforeEach(async () => {
    w = await createTestWorld();
  });

  it("a Globex user cannot act on any Acme resource id", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    const maya = w.ctx("maya");
    const preview = await createPreview(w.h.db, maya, { briefingId: p.briefingId });
    const link = await createShareLink(w.h.db, maya, { briefingId: p.briefingId });
    const g = await grantAccess(w.h.db, maya, { briefingId: p.briefingId, userId: w.seed.users.casey, role: "reader" });
    const ask = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    const fb = await submitFeedback(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, revisionNumber: 1, type: "comment", text: "hi" });
    const src = await addSource(w.h.db, maya, { briefingId: p.briefingId, kind: "text", text: "Acme private notes.", origin: "manual" });
    await drain(w);
    const ext = await getSourceExtraction(w.h.db, maya, src.sourceId);
    const op = await runIdempotent(w.h.db, maya, { action: "x.y", idempotencyKey: "k", input: {} }, async () => ({ resultRef: null, result: 1 }));

    const t = w.ctx("taylor", "globex");
    const db = w.h.db;
    await expectCode(getDraft(db, t, p.briefingId), "not_found");
    await expectCode(getBriefingMeta(db, t, p.briefingId), "not_found");
    await expectCode(getRevisionDocument(db, t, { briefingId: p.briefingId }), "not_found");
    await expectCode(updateDraft(db, t, { briefingId: p.briefingId, expectedVersion: 1, document: teamPlanBriefing }), "not_found");
    await expectCode(createPreview(db, t, { briefingId: p.briefingId }), "not_found");
    await expectCode(publishBriefing(db, t, { briefingId: p.briefingId, previewId: preview.previewId }), "not_found");
    await expectCode(withdrawPublication(db, t, { briefingId: p.briefingId, publicationId: p.pub.publicationId }), "not_found");
    await expectCode(grantAccess(db, t, { briefingId: p.briefingId, userId: w.seed.users.taylor, role: "reader" }), "not_found");
    await expectCode(revokeGrant(db, t, { briefingId: p.briefingId, grantId: g.grantId }), "not_found");
    await expectCode(revokeShareLink(db, t, { briefingId: p.briefingId, shareLinkId: link.shareLinkId }), "not_found");
    await expectCode(listShareLinks(db, t, p.briefingId), "not_found");
    await expectCode(askQuestion(db, t, { briefingId: p.briefingId, question: NRR_QUESTION }), "not_found");
    await expectCode(submitFeedback(db, t, { briefingId: p.briefingId, revisionNumber: 1, type: "comment", text: "x" }), "not_found");
    await expectCode(resolveFeedback(db, t, { feedbackId: fb.feedbackId, status: "resolved" }), "not_found");
    await expectCode(getSourceExtraction(db, t, src.sourceId), "not_found");
    await expectCode(
      addSource(db, t, { briefingId: p.briefingId, kind: "text", text: "x", origin: "manual" }),
      "not_found",
    );
    await expectCode(getOperation(db, t, op.operationId), "not_found");
    await expectCode(addTeamMember(db, w.ctx("taylor", "globex"), { teamId: w.seed.orgs.acme.teams.platform!, userId: w.seed.users.taylor }), "not_found");
    await expectCode(
      createInvitation(db, t, { kind: "briefing", email: "x@globex.example", briefingId: p.briefingId }),
      "not_found",
    );

    // Taylor's own Globex brief cannot point at Acme structure, sources, chunks or threads.
    const own = await createBriefing(db, t, { document: teamPlanBriefing, audience: { visibility: "company" } });
    await expectCode(
      createBriefing(db, t, { markdown: "# X\n\nY", home: { teamId: w.seed.orgs.acme.teams.platform! }, audience: { visibility: "company" } }),
      "validation",
    );
    await expectCode(
      changeAudience(db, t, { briefingId: own.briefingId, audience: { visibility: "team", teamId: w.seed.orgs.acme.teams.platform! } }),
      "validation",
    );
    await expectCode(
      moveBriefingHome(db, t, { briefingId: own.briefingId, home: { departmentId: w.seed.orgs.acme.departments.product! } }),
      "validation",
    );
    const gd = await getDraft(db, t, own.briefingId);
    await expectCode(
      updateDraft(db, t, {
        briefingId: own.briefingId,
        expectedVersion: gd.lockVersion,
        document: {
          ...gd.document,
          evidence: [{ id: "ev_x", title: "x", excerpt: "x", origin: "manual", status: "candidate", sourceRef: { sourceId: src.sourceId } }],
        },
      }),
      "validation",
    );
    await expectCode(
      createEvidenceFromChunk(db, t, { briefingId: own.briefingId, expectedVersion: gd.lockVersion, chunkId: ext.chunks[0]!.id, title: "x" }),
      "not_found",
    );
    // Publish Globex's brief, then try to continue an Acme thread on it.
    const gp = await createPreview(db, t, { briefingId: own.briefingId });
    await publishBriefing(db, t, { briefingId: own.briefingId, previewId: gp.previewId });
    await drain(w);
    await expectCode(askQuestion(db, t, { briefingId: own.briefingId, question: "SSO?", threadId: ask.threadId! }), "not_found");

    // An Acme member using Globex as context is not a member there.
    await expectCode(listLibrary(db, w.ctx("maya", "globex")), "not_found");
  });

  it("RLS isolates tenants under the runtime role even for raw queries", async () => {
    await makePublished(w, { user: "maya" });
    const t = w.ctx("taylor", "globex");
    const n = await withAuthContext(w.h.db, { userId: t.userId, organizationId: t.organizationId }, async (tx) => {
      const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from briefings`);
      return r.rows[0]!.n;
    });
    expect(n).toBe(0);
    await expect(
      withAuthContext(w.h.db, { userId: t.userId, organizationId: t.organizationId }, (tx) =>
        tx.execute(sql`insert into departments (organization_id, name, slug) values (${w.seed.orgs.acme.id}::uuid, 'x', 'x')`),
      ),
    ).rejects.toThrow();
  });

  it("drafts and unreleased content are collaborator-only", async () => {
    const d = await makeDraft(w, { user: "maya" });
    for (const u of ["riley", "alex", "casey"] as const) {
      await expectCode(getDraft(w.h.db, w.ctx(u), d.briefingId), "not_found");
      await expectCode(getBriefingMeta(w.h.db, w.ctx(u), d.briefingId), "not_found");
    }
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: d.briefingId, userId: w.seed.users.alex, role: "reader" });
    await expectCode(getDraft(w.h.db, w.ctx("alex"), d.briefingId), "not_found");
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: d.briefingId, userId: w.seed.users.alex, role: "editor" });
    expect((await getDraft(w.h.db, w.ctx("alex"), d.briefingId)).briefingId).toBe(d.briefingId);
    // Editors cannot publish or manage access.
    await expectCode(createPreview(w.h.db, w.ctx("alex"), { briefingId: d.briefingId }), "forbidden");
    await expectCode(grantAccess(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, userId: w.seed.users.sam, role: "reader" }), "forbidden");
    // External users can hold reader grants only.
    await expectCode(
      grantAccess(w.h.db, w.ctx("maya"), { briefingId: d.briefingId, userId: w.seed.users.casey, role: "editor" }),
      "validation",
    );
  });
});
