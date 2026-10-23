/** Test helpers for briefings/publication tests. Not exported from the package. */
import { strategyBriefing, type BriefingDocument } from "@cerebro/briefing-schema";
import type { SeedUserKey } from "@cerebro/database";
import { createBriefing, getDraft, updateDraft, type AudienceSpec, type HomeSpec } from "../briefings/index";
import type { TestWorld } from "../testing";
import { createPreview, publishBriefing } from "./index";

export interface MakeOpts {
  user?: SeedUserKey;
  document?: BriefingDocument;
  home?: HomeSpec;
  audience?: AudienceSpec;
  /** Approve evidence whose fixture status was "approved" (default true). */
  approve?: boolean;
}

/** Create a briefing and approve its evidence; returns ids and the current draft version. */
export async function makeDraft(w: TestWorld, o: MakeOpts = {}) {
  const user = o.user ?? "riley";
  const ctx = w.ctx(user);
  const doc = o.document ?? strategyBriefing;
  const created = await createBriefing(w.h.db, ctx, {
    document: doc,
    home: o.home ?? {},
    audience: o.audience ?? { visibility: "company" },
  });
  let version = created.draftVersion;
  const approveIds = doc.evidence.filter((e) => e.status === "approved").map((e) => e.id);
  if ((o.approve ?? true) && approveIds.length) {
    const r = await updateDraft(w.h.db, ctx, {
      briefingId: created.briefingId,
      expectedVersion: version,
      patch: approveIds.map((evidenceId) => ({ op: "set_evidence_status" as const, evidenceId, status: "approved" as const })),
    });
    version = r.draftVersion;
  }
  return { ...created, version, ctx, user };
}

export async function makePublished(w: TestWorld, o: MakeOpts = {}) {
  const d = await makeDraft(w, o);
  const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
  const pub = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId });
  return { ...d, preview, pub };
}

/** Small edit to the draft position headline. */
export async function editHeadline(w: TestWorld, user: SeedUserKey, briefingId: string, headline: string) {
  const ctx = w.ctx(user);
  const draft = await getDraft(w.h.db, ctx, briefingId);
  return updateDraft(w.h.db, ctx, {
    briefingId,
    expectedVersion: draft.lockVersion,
    document: { ...draft.document, position: { ...draft.document.position, headline } },
  });
}
