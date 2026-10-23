import { describe, expect, it } from "vitest";
import {
  PublishedBriefingDocument,
  canonicalJson,
  collectIssues,
  documentDigest,
  strategyBriefing,
  teamPlanBriefing,
  toPublishedDocument,
} from "./index";

describe("toPublishedDocument", () => {
  it("keeps only approved evidence, strips draft fields and drops refs to non-approved evidence", () => {
    const draft = structuredClone(strategyBriefing);
    draft.evidence[0]!.sourceRef = { sourceId: "8f9b6f2e-0d3c-4a43-9c1e-1b2a3c4d5e6f" };
    draft.evidence[1]!.status = "candidate";
    draft.evidence[2]!.status = "excluded";
    draft.sections[0]!.blocks[1]!.evidenceRefs = [{ evidenceId: "ev_missing" }];

    const { document, droppedRefs, approvedEvidence } = toPublishedDocument(draft);

    expect(approvedEvidence.map((e) => e.id)).toEqual(["ev_cohort_q3", "ev_support_capacity"]);
    expect(document.evidence.map((e) => e.id)).toEqual(["ev_cohort_q3", "ev_support_capacity"]);
    for (const e of document.evidence) {
      expect(e).not.toHaveProperty("status");
      expect(e).not.toHaveProperty("sourceRef");
    }
    expect(JSON.stringify(document)).not.toContain("sourceRef");
    expect(droppedRefs).toEqual([
      { blockId: "blk_rec_narrative", evidenceId: "ev_missing" },
      { blockId: "blk_ev_time_to_value", evidenceId: "ev_implementation_review" },
      { blockId: "blk_ev_sales_cycle", evidenceId: "ev_pipeline_review" },
    ]);
    const refs = document.sections.flatMap((s) => s.blocks.flatMap((b) => b.evidenceRefs.map((r) => r.evidenceId)));
    expect(new Set(refs)).toEqual(new Set(["ev_cohort_q3", "ev_support_capacity"]));

    // Input untouched; output is a valid, error-free published document.
    expect(draft.evidence).toHaveLength(4);
    expect(draft.evidence[0]!.sourceRef).toBeDefined();
    expect(PublishedBriefingDocument.safeParse(document).success).toBe(true);
    expect(collectIssues(document, { mode: "publish" }).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("is idempotent", () => {
    const once = toPublishedDocument(teamPlanBriefing);
    const twice = toPublishedDocument(once.document);
    expect(twice.droppedRefs).toEqual([]);
    expect(documentDigest(twice.document)).toBe(documentDigest(once.document));
    expect(once.document.evidence.map((e) => e.id)).toEqual(["ev_tp_security_reviews"]);
  });

  it("re-parsing a published document does not reintroduce draft status", () => {
    const { document } = toPublishedDocument(strategyBriefing);
    const reparsed = PublishedBriefingDocument.parse(JSON.parse(JSON.stringify(document)));
    expect(reparsed.evidence[0]).not.toHaveProperty("status");
  });
});

describe("documentDigest", () => {
  it("is stable across key order and sensitive to content", () => {
    const a = { b: 1, a: { y: [1, { z: true, c: "x" }], x: null }, u: undefined };
    const b = { a: { x: null, y: [1, { c: "x", z: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(documentDigest(a)).toBe(documentDigest(b));
    expect(documentDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(documentDigest({ ...b, b: 2 })).not.toBe(documentDigest(b));
    // Array order matters.
    expect(documentDigest([1, 2])).not.toBe(documentDigest([2, 1]));
  });

  it("matches for a document whose keys were reordered", () => {
    const reversed = JSON.parse(
      JSON.stringify(strategyBriefing, function (_key, value) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value).reverse());
        }
        return value;
      }),
    );
    expect(Object.keys(reversed)[0]).not.toBe(Object.keys(strategyBriefing)[0]);
    expect(documentDigest(reversed)).toBe(documentDigest(strategyBriefing));
    const changed = structuredClone(strategyBriefing);
    changed.evidence[0]!.status = "excluded";
    expect(documentDigest(changed)).not.toBe(documentDigest(strategyBriefing));
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});
