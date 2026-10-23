import { auditEvents, briefingGrants, withSystemContext } from "@cerebro/database";
import { sampleHandoff, strategyBriefing, teamPlanBriefing } from "@cerebro/briefing-schema";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { createTestWorld, type TestWorld } from "../testing";
import { editHeadline, makeDraft, makePublished } from "../publication/test-utils";
import { createPreview, publishBriefing } from "../publication/index";
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
  setEvidenceStatus,
  updateDraft,
} from "./index";

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

describe("createBriefing", () => {
  it("creates briefing, owner and draft at lock_version 1 with an org-unique slug", async () => {
    const a = await createBriefing(w.h.db, w.ctx("riley"), { document: strategyBriefing, audience: { visibility: "company" } });
    const b = await createBriefing(w.h.db, w.ctx("maya"), { document: strategyBriefing, audience: { visibility: "company" } });
    expect(a.draftVersion).toBe(1);
    expect(a.slug).toBe("our-next-chapter-a-focused-move-upmarket");
    expect(b.slug).toBe("our-next-chapter-a-focused-move-upmarket-2");
    const draft = await getDraft(w.h.db, w.ctx("riley"), a.briefingId);
    expect(draft.lockVersion).toBe(1);
    // No evidence is approved on arrival.
    expect(draft.evidence.every((e) => e.status === "candidate")).toBe(true);
    const meta = await getBriefingMeta(w.h.db, w.ctx("riley"), a.briefingId);
    expect(meta.owner.userId).toBe(w.seed.users.riley);
    expect(meta.currentPublication).toBeNull();
    expect(meta.capabilities).toContain("publish");
  });

  it("composes from a handoff and from markdown, returning gaps", async () => {
    const h = await createBriefing(w.h.db, w.ctx("maya"), { handoff: sampleHandoff, audience: { visibility: "company" } });
    expect(h.briefingId).toBeTruthy();
    const m = await createBriefing(w.h.db, w.ctx("maya"), {
      markdown: "# Quick note\n\nWe should do the thing.\n\n## Details\n\nSome detail.",
      audience: { visibility: "company" },
    });
    expect(m.gaps.length).toBeGreaterThan(0);
    await expectCode(createBriefing(w.h.db, w.ctx("maya"), { handoff: { handoffVersion: 9 }, audience: { visibility: "company" } }), "validation");
  });

  it("validates home and audience ids in-org", async () => {
    const acme = w.seed.orgs.acme;
    const globex = w.seed.orgs.globex;
    // Team must belong to the department.
    await expectCode(
      createBriefing(w.h.db, w.ctx("maya"), {
        document: teamPlanBriefing,
        home: { departmentId: acme.departments.finance, teamId: acme.teams.platform },
        audience: { visibility: "company" },
      }),
      "validation",
    );
    // Cross-tenant department / team ids are rejected.
    await expectCode(
      createBriefing(w.h.db, w.ctx("maya"), { document: teamPlanBriefing, home: { departmentId: globex.departments.operations }, audience: { visibility: "company" } }),
      "validation",
    );
    await expectCode(
      createBriefing(w.h.db, w.ctx("maya"), { document: teamPlanBriefing, audience: { visibility: "team", teamId: globex.teams.logistics } }),
      "validation",
    );
    // Inferred department from team.
    const ok = await createBriefing(w.h.db, w.ctx("maya"), {
      document: teamPlanBriefing,
      home: { teamId: acme.teams.platform },
      audience: { visibility: "team", teamId: acme.teams.platform },
    });
    const meta = await getBriefingMeta(w.h.db, w.ctx("maya"), ok.briefingId);
    expect(meta.home.label).toBe("Acme / Product / Platform");
    expect(meta.audience.label).toBe("Platform team");
  });

  it("requires active company membership (external reader cannot create)", async () => {
    await expectCode(createBriefing(w.h.db, w.ctx("casey"), { document: strategyBriefing, audience: { visibility: "company" } }), "forbidden");
  });
});

describe("drafts", () => {
  it("rejects a stale expectedVersion with conflict and never overwrites", async () => {
    const d = await makeDraft(w);
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    const first = await updateDraft(w.h.db, d.ctx, {
      briefingId: d.briefingId,
      expectedVersion: draft.lockVersion,
      document: { ...draft.document, title: "Edited by author" },
    });
    expect(first.draftVersion).toBe(draft.lockVersion + 1);
    const err = await expectCode(
      updateDraft(w.h.db, d.ctx, {
        briefingId: d.briefingId,
        expectedVersion: draft.lockVersion,
        document: { ...draft.document, title: "Concurrent edit" },
      }),
      "conflict",
    );
    expect(err.details).toEqual({ currentVersion: first.draftVersion });
    expect((await getDraft(w.h.db, d.ctx, d.briefingId)).document.title).toBe("Edited by author");
  });

  it("rejects an AI-style (mcp) update against an old version", async () => {
    const d = await makeDraft(w);
    await editHeadline(w, "riley", d.briefingId, "Author's newer headline.");
    const mcp = w.ctx("riley", "acme", "mcp");
    const err = await expectCode(
      setEvidenceStatus(w.h.db, mcp, { briefingId: d.briefingId, expectedVersion: d.version, evidenceId: "ev_cohort_q3", status: "excluded" }),
      "conflict",
    );
    expect(err.details?.currentVersion).toBe(d.version + 1);
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    expect(draft.document.position.headline).toBe("Author's newer headline.");
    expect(draft.evidence.find((e) => e.id === "ev_cohort_q3")?.status).toBe("approved");
  });

  it("denies draft access to readers, admins and other members", async () => {
    const d = await makePublished(w, { user: "maya" });
    await expectCode(getDraft(w.h.db, w.ctx("alex"), d.briefingId), "forbidden");
    // Company owner (Riley) has no implicit draft access (D09).
    await expectCode(getDraft(w.h.db, w.ctx("riley"), d.briefingId), "forbidden");
    await expectCode(
      updateDraft(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, expectedVersion: d.version, document: strategyBriefing }),
      "forbidden",
    );
  });

  it("rejects a cross-tenant briefing id", async () => {
    const d = await makeDraft(w);
    await expectCode(getDraft(w.h.db, w.ctx("taylor", "globex"), d.briefingId), "not_found");
    await expectCode(getBriefingMeta(w.h.db, w.ctx("taylor", "globex"), d.briefingId), "not_found");
    await expectCode(
      updateDraft(w.h.db, w.ctx("taylor", "globex"), { briefingId: d.briefingId, expectedVersion: 1, document: strategyBriefing }),
      "not_found",
    );
    // Even Riley, in the wrong company context, cannot reach it.
    await expectCode(getDraft(w.h.db, { ...w.ctx("riley"), organizationId: w.seed.orgs.globex.id }, d.briefingId), "not_found");
  });
});

describe("home and audience", () => {
  it("moving home never changes audience; changing audience is separate and audited", async () => {
    const acme = w.seed.orgs.acme;
    const d = await makePublished(w, { user: "maya", audience: { visibility: "team", teamId: acme.teams.platform } });
    // Maya may home it in Product through her Platform team membership (D10).
    await moveBriefingHome(w.h.db, d.ctx, { briefingId: d.briefingId, home: { departmentId: acme.departments.product } });
    const meta = await getBriefingMeta(w.h.db, d.ctx, d.briefingId);
    expect(meta.home.department?.id).toBe(acme.departments.product);
    expect(meta.audience.visibility).toBe("team");
    expect(meta.audience.team?.id).toBe(acme.teams.platform);
    // Priya (explicit Product member, not Platform) still cannot read: moving did not broaden access.
    await expectCode(getRevisionDocument(w.h.db, w.ctx("priya"), { briefingId: d.briefingId }), "not_found");

    await changeAudience(w.h.db, d.ctx, { briefingId: d.briefingId, audience: { visibility: "company" } });
    expect((await getRevisionDocument(w.h.db, w.ctx("priya"), { briefingId: d.briefingId })).revision.revisionNumber).toBe(1);
    // Editors cannot change audience.
    await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.alex, role: "editor" });
    await expectCode(changeAudience(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, audience: { visibility: "restricted" } }), "forbidden");

    const actions = await withSystemContext(w.h.db, (tx) =>
      tx.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.targetId, d.briefingId)),
    );
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["briefing.home_moved", "briefing.audience_changed", "grant.created"]));
  });
});

describe("reading", () => {
  it("reader DTOs never include draft-only fields", async () => {
    const d = await makePublished(w);
    const doc = await getRevisionDocument(w.h.db, w.ctx("alex"), { slug: d.slug });
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"status"');
    expect(json).not.toContain('"sourceRef"');
    expect(json).not.toContain('"sourceId"');
    expect(doc.evidence.length).toBe(strategyBriefing.evidence.length);
    const meta = await getBriefingMeta(w.h.db, w.ctx("alex"), { slug: d.slug });
    expect(meta.draft).toBeUndefined();
    expect(meta.audience.namedReaders).toBeUndefined();
    expect(meta.capabilities).toEqual(["read", "view_evidence"]);
  });

  it("lists revisions and compares revisions and draft", async () => {
    const d = await makePublished(w);
    await editHeadline(w, "riley", d.briefingId, "A sharper headline.");
    const p2 = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(p2.changeSummary.join(" ")).toMatch(/position|headline/i);
    await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: p2.previewId, changeSummary: "Sharper headline." });
    const revs = await listRevisions(w.h.db, w.ctx("alex"), d.briefingId);
    expect(revs.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(revs[0]!.changeSummary).toBe("Sharper headline.");
    expect(revs[0]!.isCurrent).toBe(true);
    const cmp = await compareRevisions(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, from: 1, to: 2 });
    expect(cmp.diff.position).toContain("headline");
    await expectCode(compareRevisions(w.h.db, w.ctx("alex"), { briefingId: d.briefingId, from: 2, to: "draft" }), "forbidden");
    const toDraft = await compareRevisions(w.h.db, d.ctx, { briefingId: d.briefingId, from: 2, to: "draft" });
    expect(toDraft.diff.hasChanges).toBe(false);
  });
});

describe("grants", () => {
  it("an external reader grant reads the publication but never the draft", async () => {
    const d = await makePublished(w, { audience: { visibility: "restricted" } });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId }), "not_found");
    const g = await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, email: "casey@partner.example", role: "reader" });
    expect(g.external).toBe(true);
    const doc = await getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId });
    expect(doc.revision.revisionNumber).toBe(1);
    await expectCode(getDraft(w.h.db, w.ctx("casey"), d.briefingId), "forbidden");
    // External readers cannot be editors.
    await expectCode(grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.casey, role: "editor" }), "validation");
    // Only manage_access can see or change grants.
    await expectCode(listAccess(w.h.db, w.ctx("casey"), d.briefingId), "forbidden");
    await revokeGrant(w.h.db, d.ctx, { briefingId: d.briefingId, grantId: g.grantId });
    await expectCode(getRevisionDocument(w.h.db, w.ctx("casey"), { briefingId: d.briefingId }), "not_found");
  });

  it("revision scope requires the reader role", async () => {
    const d = await makePublished(w);
    await expectCode(
      grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.alex, role: "editor", revisionNumber: 1 }),
      "validation",
    );
    const g = await grantAccess(w.h.db, d.ctx, { briefingId: d.briefingId, userId: w.seed.users.casey, role: "reader", revisionNumber: 1 });
    expect(g.revisionNumber).toBe(1);
    const rows = await withSystemContext(w.h.db, (tx) =>
      tx.select().from(briefingGrants).where(and(eq(briefingGrants.briefingId, d.briefingId), eq(briefingGrants.userId, w.seed.users.casey))),
    );
    expect(rows).toHaveLength(1);
  });
});
