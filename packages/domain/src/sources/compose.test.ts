import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GAP_PLACEHOLDERS, GAP_PREFIX, newId, SCHEMA_VERSION, type BriefingDocument } from "@cerebro/briefing-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocx, buildPptx } from "../../../capture/test/fixtures";
import { buildScannedPdf, textImage } from "../../../capture/test/image-fixtures";
import { createBriefing, getDraft, updateDraft } from "../briefings/index";
import { DomainError } from "../errors";
import { drainJobs, makePublishedBriefing } from "../engagement/test-fixtures";
import { createTestWorld, type TestWorld } from "../testing";
import { ocrOptionsFromEnv } from "../jobs/index";
import { addSource, composeDraftFromSource, getSourceExtraction, isUntouchedTemplate, listBriefingSources, LocalSourceStore, setSourceStore } from "./index";

let w: TestWorld;
let objects: string;
beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-objects-"));
  setSourceStore(new LocalSourceStore(objects));
});
afterEach(async () => {
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

const isCode = (code: string, reason?: string) => (e: unknown) =>
  e instanceof DomainError &&
  e.code === code &&
  (!reason || ((e.details as { reasons?: string[] } | undefined)?.reasons ?? []).includes(reason));

/** Same shape as the web app's blank template (components/briefing/document-utils.ts). */
function blankDocument(title: string): BriefingDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    kind: "strategy",
    position: { headline: GAP_PLACEHOLDERS.headline, summary: GAP_PLACEHOLDERS.summary },
    context: { stakes: GAP_PLACEHOLDERS.stakes },
    request: { type: "decision", statement: GAP_PLACEHOLDERS.request },
    sections: [
      {
        id: newId("sec"),
        title: "The recommendation",
        blocks: [{ id: newId("blk"), type: "narrative", role: "general", text: `${GAP_PREFIX}explain the recommendation.`, evidenceRefs: [] }],
      },
    ],
    perspectives: [],
    evidence: [],
    openQuestions: [],
  };
}

async function blankBriefing(title = "Q3 plan") {
  return createBriefing(w.h.db, w.ctx("maya"), { document: blankDocument(title), audience: { visibility: "company" } });
}

const deck = () =>
  buildPptx([
    { title: "Expand the pilot", body: ["Onboarding time fell to 41 days.", "Support load stayed flat."] },
    { title: "Risks", body: ["Support capacity is limited in Q4."] },
  ]);

describe("listBriefingSources", () => {
  it("lists linked sources with status and gap counts for collaborators only", async () => {
    const b = await blankBriefing();
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, kind: "pptx", filename: "plan.pptx", bytes: await deck(), origin: "upload" });
    let list = await listBriefingSources(w.h.db, w.ctx("maya"), b.briefingId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sourceId: src.sourceId, status: "pending", captureKind: "pptx", origin: "upload", gapCount: 0, chunkCount: 0 });

    await drainJobs(w);
    list = await listBriefingSources(w.h.db, w.ctx("maya"), b.briefingId);
    expect(list[0]).toMatchObject({ status: "succeeded", completeness: "complete" });
    expect(list[0]!.chunkCount).toBeGreaterThan(0);

    // Not a collaborator on an unpublished draft: indistinguishable from missing.
    await expect(listBriefingSources(w.h.db, w.ctx("alex"), b.briefingId)).rejects.toSatisfy(isCode("not_found"));
  });

  it("forbids readers of a published briefing", async () => {
    const fb = await makePublishedBriefing(w);
    await expect(listBriefingSources(w.h.db, w.ctx("alex"), fb.id)).rejects.toSatisfy(isCode("forbidden"));
    expect(await listBriefingSources(w.h.db, w.ctx("maya"), fb.id)).toEqual([]);
  });
});

describe("composeDraftFromSource", () => {
  it("composes a blank draft from an extracted deck with candidate evidence", async () => {
    const b = await blankBriefing("Pilot deck");
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, kind: "pptx", filename: "pilot.pptx", bytes: await deck(), origin: "upload" });

    await expect(
      composeDraftFromSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: 1, sourceId: src.sourceId }),
    ).rejects.toSatisfy(isCode("validation", "extraction_pending"));

    await drainJobs(w);
    const res = await composeDraftFromSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: 1, sourceId: src.sourceId });
    expect(res).toMatchObject({ draftVersion: 2, replaced: false });
    expect(res.evidenceAdded).toBeGreaterThan(0);

    const draft = await getDraft(w.h.db, w.ctx("maya"), b.briefingId);
    const doc = draft.document;
    expect(doc.title).toBe("Pilot deck");
    expect(doc.sections.map((s) => s.title)).toEqual(["Slide 1: Expand the pilot", "Slide 2: Risks"]);
    expect(JSON.stringify(doc.sections)).toContain("41 days");
    // Nothing is invented: the position stays an explicit gap.
    expect(doc.position.headline).toBe(GAP_PLACEHOLDERS.headline);
    // Every passage is a candidate with sourceRef and locator; none approved.
    expect(doc.evidence.length).toBe(res.evidenceAdded);
    for (const e of doc.evidence) {
      expect(e.status).toBe("candidate");
      expect(e.sourceRef?.sourceId).toBe(src.sourceId);
      expect(e.sourceRef?.chunkId).toBeTruthy();
      expect(e.locator).toMatch(/^Slide \d/);
    }
    const refs = doc.sections.flatMap((s) => s.blocks.flatMap((bl) => bl.evidenceRefs.map((r) => r.evidenceId)));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((id) => doc.evidence.some((e) => e.id === id))).toBe(true);
  });

  it("refuses a stale version and a draft with content unless replace is explicit", async () => {
    const b = await blankBriefing();
    const bytes = await buildDocx(["Quarterly review of onboarding.", "Median time to value fell to 41 days."]);
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, kind: "docx", filename: "review.docx", bytes, origin: "upload" });
    await drainJobs(w);

    // Author edits the draft first.
    const draft = await getDraft(w.h.db, w.ctx("maya"), b.briefingId);
    const edited = { ...draft.document, position: { ...draft.document.position, headline: "Expand the pilot" } };
    expect(isUntouchedTemplate(draft.document)).toBe(true);
    expect(isUntouchedTemplate(edited)).toBe(false);
    const saved = await updateDraft(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: 1, document: edited });

    await expect(
      composeDraftFromSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: 1, sourceId: src.sourceId }),
    ).rejects.toSatisfy(isCode("conflict"));
    await expect(
      composeDraftFromSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: saved.draftVersion, sourceId: src.sourceId }),
    ).rejects.toSatisfy(isCode("conflict", "draft_not_blank"));
    // Unchanged.
    expect((await getDraft(w.h.db, w.ctx("maya"), b.briefingId)).lockVersion).toBe(saved.draftVersion);

    const res = await composeDraftFromSource(w.h.db, w.ctx("maya"), {
      briefingId: b.briefingId,
      expectedVersion: saved.draftVersion,
      sourceId: src.sourceId,
      replace: true,
    });
    expect(res).toMatchObject({ replaced: true, draftVersion: saved.draftVersion + 1 });
    const after = await getDraft(w.h.db, w.ctx("maya"), b.briefingId);
    expect(after.document.evidence.every((e) => e.status === "candidate" && e.locator?.startsWith("Paragraph"))).toBe(true);
  });

  it("requires edit and a source linked to the briefing", async () => {
    const b = await blankBriefing();
    const other = await blankBriefing("Other");
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: other.briefingId, kind: "text", text: "Churn fell by four points.", origin: "manual" });
    await drainJobs(w);
    await expect(
      composeDraftFromSource(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, expectedVersion: 1, sourceId: src.sourceId }),
    ).rejects.toSatisfy(isCode("not_found"));
    await expect(
      composeDraftFromSource(w.h.db, w.ctx("alex"), { briefingId: other.briefingId, expectedVersion: 1, sourceId: src.sourceId }),
    ).rejects.toSatisfy(isCode("not_found"));
  });

  it("composes automatically after extraction when the upload asked for it and the draft is blank", async () => {
    const b = await blankBriefing("Pilot deck");
    await addSource(w.h.db, w.ctx("maya"), {
      briefingId: b.briefingId,
      kind: "pptx",
      filename: "pilot.pptx",
      bytes: await deck(),
      origin: "upload",
      composeDraft: true,
    });
    await drainJobs(w);
    const draft = await getDraft(w.h.db, w.ctx("maya"), b.briefingId);
    expect(draft.lockVersion).toBe(2);
    expect(draft.document.sections[0]!.title).toBe("Slide 1: Expand the pilot");
    expect(draft.document.evidence.every((e) => e.status === "candidate")).toBe(true);
  });

  it("never auto-composes over a draft that already has content", async () => {
    const fb = await makePublishedBriefing(w);
    const before = await getDraft(w.h.db, w.ctx("maya"), fb.id);
    await addSource(w.h.db, w.ctx("maya"), { briefingId: fb.id, kind: "text", text: "Churn fell.", origin: "upload", composeDraft: true });
    await drainJobs(w);
    const after = await getDraft(w.h.db, w.ctx("maya"), fb.id);
    expect(after.lockVersion).toBe(before.lockVersion);
    expect(after.document).toEqual(before.document);
  });
});

describe("OCR sources", () => {
  it(
    "reads an uploaded image in the extraction job and composes candidate evidence marked as OCR",
    async () => {
      const b = await blankBriefing("Whiteboard");
      const src = await addSource(w.h.db, w.ctx("maya"), {
        briefingId: b.briefingId,
        kind: "image",
        filename: "whiteboard.jpg",
        bytes: await textImage(["Onboarding time fell to 41 days"], { format: "jpeg" }),
        origin: "upload",
        composeDraft: true,
      });
      // Nothing is read at upload time: OCR runs only in the job.
      expect((await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId)).status).toBe("pending");
      await drainJobs(w);

      const ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
      expect(ex).toMatchObject({ captureKind: "image", status: "succeeded", completeness: "complete", chunkCount: 1 });
      expect(ex.chunks[0]!.locator).toMatch(/^Image \(OCR, \d{1,3}% confidence\)$/);
      expect(ex.chunks[0]!.preview.toLowerCase()).toContain("onboarding time fell");
      expect(ex.gaps).toContainEqual(expect.objectContaining({ code: "ocr_used", locator: "Image", affectsCompleteness: false }));

      const draft = await getDraft(w.h.db, w.ctx("maya"), b.briefingId);
      expect(draft.document.evidence).toHaveLength(1);
      expect(draft.document.evidence[0]).toMatchObject({ status: "candidate", locator: expect.stringContaining("(OCR,") });
    },
    60_000,
  );

  it(
    "OCRs only the scanned pages of an uploaded PDF",
    async () => {
      const b = await blankBriefing("Scan");
      const src = await addSource(w.h.db, w.ctx("maya"), {
        briefingId: b.briefingId,
        kind: "pdf",
        filename: "scan.pdf",
        bytes: buildScannedPdf([{ text: ["Decision requested: approve the pilot budget."] }, { scan: ["Budget approved in March"] }]),
        origin: "upload",
      });
      await drainJobs(w);
      const ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
      expect(ex.status).toBe("succeeded");
      expect(ex.chunks.map((c) => c.locator)).toEqual(["p. 1", expect.stringMatching(/^p\. 2 \(OCR, \d{1,3}% confidence\)$/)]);
    },
    60_000,
  );

  it("reads OCR settings from the environment, English by default", () => {
    expect(ocrOptionsFromEnv({})).toEqual({});
    expect(ocrOptionsFromEnv({ CEREBRO_OCR: "off" })).toEqual({ enabled: false });
    expect(ocrOptionsFromEnv({ CEREBRO_OCR_LANGUAGES: "eng, deu", CEREBRO_OCR_LANG_PATH: "/opt/tessdata" })).toEqual({ languages: ["eng", "deu"], langPath: "/opt/tessdata" });
  });
});
