import { describe, expect, it } from "vitest";
import { diffDocuments, strategyBriefing, type BriefingDocument } from "./index";

const clone = (): BriefingDocument => structuredClone(strategyBriefing);

describe("diffDocuments", () => {
  it("reports no changes for identical documents", () => {
    const diff = diffDocuments(strategyBriefing, clone());
    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toEqual([]);
  });

  it("treats a pure reorder as moves, not removals and additions", () => {
    const next = clone();
    next.sections.reverse();
    next.sections[0]!.blocks.reverse(); // Next steps, reversed
    const diff = diffDocuments(strategyBriefing, next);
    expect(diff.sections.added).toEqual([]);
    expect(diff.sections.removed).toEqual([]);
    expect(diff.blocks.added).toEqual([]);
    expect(diff.blocks.removed).toEqual([]);
    expect(diff.blocks.changed).toEqual([]);
    expect(diff.sections.moved.length).toBe(4); // LCS keeps one section in place
    expect(diff.blocks.moved.every((m) => m.fromSectionId === "sec_next_steps")).toBe(true);
    expect(diff.blocks.moved.length).toBe(3);
  });

  it("detects section, block, top-level, perspective and evidence changes by id", () => {
    const next = clone();
    next.title = "A focused move upmarket";
    next.request.statement = "Approve a 120-day mid-market pilot.";
    next.context.background = undefined;
    // Rename + move section to the front
    const tradeoffs = next.sections.splice(3, 1)[0]!;
    tradeoffs.title = "What we are deferring";
    next.sections.unshift(tradeoffs);
    // Remove a section, add one
    next.sections = next.sections.filter((s) => s.id !== "sec_evidence");
    next.sections.push({
      id: "sec_faq",
      title: "Questions",
      blocks: [{ id: "blk_faq_1", type: "narrative", role: "general", text: "Answers to common questions.", evidenceRefs: [] }],
    });
    // Change a block's fields
    const metricHome = strategyBriefing.sections[2]!.blocks[0]!;
    expect(metricHome.type).toBe("metric");
    const why = next.sections.find((s) => s.id === "sec_why_now")!;
    const chart = why.blocks[1]!;
    if (chart.type !== "chart") throw new Error("fixture changed");
    chart.caption = "Updated caption";
    chart.series[0]!.points[1]!.y = 125;
    // Move a block across sections
    const rec = next.sections.find((s) => s.id === "sec_recommendation")!;
    const narrative = rec.blocks.pop()!;
    why.blocks.push(narrative);
    // Perspectives / evidence
    next.perspectives[0]!.summary = "Revised.";
    next.perspectives.pop();
    next.perspectives.push({ id: "psp_sales", label: "Sales", summary: "For sales.", emphasis: [], implications: [] });
    next.evidence.pop();
    next.evidence.push({ id: "ev_new", title: "New survey", excerpt: "x", origin: "manual", status: "candidate" });
    next.openQuestions[0]!.text = "Reworded?";

    const diff = diffDocuments(strategyBriefing, next);

    expect(diff.meta).toEqual([{ field: "title", from: strategyBriefing.title, to: next.title }]);
    expect(diff.request).toEqual(["statement"]);
    expect(diff.context).toEqual(["background"]);
    expect(diff.position).toEqual([]);
    expect(diff.sections.added.map((s) => s.id)).toEqual(["sec_faq"]);
    expect(diff.sections.removed.map((s) => s.id)).toEqual(["sec_evidence"]);
    expect(diff.sections.renamed).toEqual([{ id: "sec_tradeoffs", from: "Tradeoffs", to: "What we are deferring" }]);
    expect(diff.sections.moved.map((s) => s.id)).toEqual(["sec_tradeoffs"]);
    expect(diff.blocks.added.map((b) => b.id)).toEqual(["blk_faq_1"]);
    expect(diff.blocks.removed.map((b) => b.id).sort()).toEqual(
      ["blk_ev_nrr_metric", "blk_ev_sales_cycle", "blk_ev_time_to_value"].sort(),
    );
    expect(diff.blocks.changed).toEqual([
      expect.objectContaining({ id: "blk_why_nrr_chart", type: "chart", fields: ["caption", "series"] }),
    ]);
    expect(diff.blocks.changed[0]!.summary).toContain("Net revenue retention by segment");
    expect(diff.blocks.moved).toEqual([
      expect.objectContaining({ id: "blk_rec_narrative", fromSectionId: "sec_recommendation", toSectionId: "sec_why_now" }),
    ]);
    expect(diff.perspectives.added.map((p) => p.id)).toEqual(["psp_sales"]);
    expect(diff.perspectives.removed.map((p) => p.id)).toEqual(["psp_operations"]);
    expect(diff.perspectives.changed).toEqual([{ id: "psp_finance", label: "Finance", fields: ["summary"] }]);
    expect(diff.evidence.added.map((e) => e.id)).toEqual(["ev_new"]);
    expect(diff.evidence.removed.map((e) => e.id)).toEqual(["ev_support_capacity"]);
    expect(diff.openQuestions.changed.map((q) => q.id)).toEqual(["itm_q_criteria"]);
    expect(diff.hasChanges).toBe(true);
    expect(diff.summary).toEqual(
      expect.arrayContaining([
        "Added section “Questions”.",
        "Removed section “The evidence”.",
        "Renamed section “Tradeoffs” to “What we are deferring”.",
        "Added the Sales perspective.",
        "Added evidence “New survey”.",
      ]),
    );
  });

  it("reports evidence approval changes", () => {
    const next = clone();
    next.evidence[0]!.status = "excluded";
    const diff = diffDocuments(strategyBriefing, next);
    expect(diff.evidence.changed).toEqual([{ id: "ev_cohort_q3", title: "Customer cohort analysis", fields: ["status"] }]);
  });
});
