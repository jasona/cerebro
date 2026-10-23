import { describe, expect, it } from "vitest";
import { collectIssues, parseDocument, strategyBriefing, validateDocument, type BriefingDocument } from "./index";

const clone = (): BriefingDocument => structuredClone(strategyBriefing);
const codes = (doc: BriefingDocument, mode: "draft" | "publish" = "draft") => collectIssues(doc, { mode });
const find = (doc: BriefingDocument, code: string, mode: "draft" | "publish" = "draft") =>
  codes(doc, mode).filter((i) => i.code === code);

describe("parseDocument", () => {
  it("returns structured issues with JSON paths and block ids", () => {
    const input = structuredClone(strategyBriefing) as unknown as { sections: { blocks: Record<string, unknown>[] }[] };
    input.sections[1]!.blocks[1]!.altText = "";
    const result = parseDocument(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({
      severity: "error",
      path: "$.sections[1].blocks[1].altText",
      blockId: "blk_why_nrr_chart",
    });
    expect(result.issues[0]!.code).toMatch(/^schema\./);
  });

  it("rejects non-objects", () => {
    const result = parseDocument("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe("$");
  });
});

describe("collectIssues", () => {
  it("flags duplicate ids anywhere", () => {
    const doc = clone();
    doc.sections[1]!.blocks[0]!.id = "blk_rec_decision";
    doc.openQuestions[1]!.id = "itm_opt_pilot";
    const dups = find(doc, "duplicate_id");
    expect(dups.map((d) => d.path)).toEqual(["$.sections[1].blocks[0].id", "$.openQuestions[1].id"]);
    expect(dups.every((d) => d.severity === "error")).toBe(true);
  });

  it("flags perspective emphasis on missing sections", () => {
    const doc = clone();
    doc.perspectives[0]!.emphasis.push("sec_missing");
    expect(find(doc, "perspective_emphasis_missing_section")).toEqual([
      expect.objectContaining({ severity: "error", path: "$.perspectives[0].emphasis[2]" }),
    ]);
  });

  it("flags implications referencing missing blocks", () => {
    const doc = clone();
    doc.perspectives[1]!.implications[0]!.blockIds = ["blk_gone"];
    expect(find(doc, "implication_missing_block")[0]).toMatchObject({
      severity: "error",
      path: "$.perspectives[1].implications[0].blockIds[0]",
    });
  });

  it("flags evidence refs to missing evidence as errors", () => {
    const doc = clone();
    doc.sections[0]!.blocks[1]!.evidenceRefs = [{ evidenceId: "ev_nowhere" }];
    expect(find(doc, "evidence_ref_missing")[0]).toMatchObject({
      severity: "error",
      blockId: "blk_rec_narrative",
      path: "$.sections[0].blocks[1].evidenceRefs[0].evidenceId",
    });
  });

  it("warns that claims citing non-approved evidence will publish without evidence", () => {
    const doc = clone();
    doc.evidence[1]!.status = "candidate";
    doc.evidence[2]!.status = "excluded";
    const issues = find(doc, "evidence_ref_unapproved", "publish");
    expect(issues.map((i) => i.blockId)).toEqual(["blk_ev_time_to_value", "blk_ev_sales_cycle"]);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues[0]!.message).toContain("claim will publish without evidence");
  });

  it("treats empty sections as warnings in drafts and errors at publish", () => {
    const doc = clone();
    doc.sections[2]!.blocks = [];
    expect(find(doc, "empty_section", "draft")[0]?.severity).toBe("warning");
    expect(find(doc, "empty_section", "publish")[0]).toMatchObject({ severity: "error", path: "$.sections[2].blocks" });
  });

  it("warns when a decision is requested but there is no decision block", () => {
    const doc = clone();
    doc.sections[0]!.blocks.shift();
    expect(find(doc, "decision_request_without_decision_block")).toEqual([
      expect.objectContaining({ severity: "warning", path: "$.request" }),
    ]);
    doc.request.type = "awareness";
    expect(find(doc, "decision_request_without_decision_block")).toEqual([]);
  });

  it("flags chart series with different lengths", () => {
    const doc = clone();
    const chart = doc.sections[1]!.blocks[1]!;
    if (chart.type !== "chart") throw new Error("fixture changed");
    chart.series.push({ label: "Last year", points: [{ x: "Small business", y: 1 }] });
    expect(find(doc, "chart_series_length_mismatch")[0]).toMatchObject({ severity: "error", blockId: "blk_why_nrr_chart" });
  });

  it("flags comparison rows whose cell count differs from columns", () => {
    const doc = clone();
    const cmp = doc.sections[3]!.blocks[0]!;
    if (cmp.type !== "comparison") throw new Error("fixture changed");
    cmp.rows[1]!.cells.pop();
    expect(find(doc, "comparison_cells_mismatch")[0]).toMatchObject({
      severity: "error",
      path: "$.sections[3].blocks[0].rows[1].cells",
    });
  });

  it("warns when no approved evidence is attached", () => {
    const doc = clone();
    for (const e of doc.evidence) e.status = "candidate";
    expect(find(doc, "no_approved_evidence")[0]).toMatchObject({
      severity: "warning",
      message: "No supporting evidence attached.",
    });
    doc.evidence = [];
    doc.sections.forEach((s) => s.blocks.forEach((b) => (b.evidenceRefs = [])));
    expect(find(doc, "no_approved_evidence")).toHaveLength(1);
  });

  it("validateDocument separates errors from content-gap warnings", () => {
    const doc = clone();
    for (const e of doc.evidence) e.status = "candidate";
    const report = validateDocument(doc, { mode: "publish" });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
