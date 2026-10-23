import { describe, expect, it } from "vitest";
import { strategyBriefing, teamPlanBriefing, type BriefingDocument, type Perspective } from "@cerebro/briefing-schema";
import {
  DeterministicProvider,
  runTask,
  suggestPerspectivesDeterministic,
  SuggestPerspectivesTask,
  suggestPerspectivesPrompt,
  validateSuggestedPerspective,
} from "./index";

const base: Perspective = {
  id: "psp_suggested01",
  label: "Delivery",
  audience: "Teams delivering the plan",
  summary: "The pod starts in 2026-11 and reviews at day 90.",
  emphasis: ["sec_next_steps"],
  implications: [{ id: "itm_suggested01", text: "Draft stop-or-scale criteria for leadership review.", blockIds: ["blk_action_criteria"] }],
};

describe("validateSuggestedPerspective (D06)", () => {
  it("accepts a perspective over existing sections, blocks and stated numbers", () => {
    const v = validateSuggestedPerspective(strategyBriefing, base);
    expect(v.ok).toBe(true);
  });

  it("puts emphasis into reading order", () => {
    const v = validateSuggestedPerspective(strategyBriefing, { ...base, emphasis: ["sec_next_steps", "sec_recommendation"] });
    expect(v.ok && v.perspective.emphasis).toEqual(["sec_recommendation", "sec_next_steps"]);
  });

  const codes = (doc: BriefingDocument, p: unknown, opts = {}) => {
    const v = validateSuggestedPerspective(doc, p, opts);
    return v.ok ? [] : v.issues.map((i) => i.code);
  };

  it("rejects sections and blocks that do not exist", () => {
    expect(codes(strategyBriefing, { ...base, emphasis: ["sec_invented_one"] })).toContain("unknown_section");
    expect(codes(strategyBriefing, { ...base, implications: [{ id: "itm_x0001", text: "See it.", blockIds: ["blk_invented01"] }] })).toContain(
      "unknown_block",
    );
  });

  it("rejects ids in text that do not exist (for example invented evidence)", () => {
    expect(codes(strategyBriefing, { ...base, summary: "Backed by ev_invented_survey." })).toContain("unknown_reference");
    expect(codes(strategyBriefing, { ...base, summary: "Backed by ev_cohort_q3." })).toEqual([]);
  });

  it("rejects numbers the briefing does not state (no new facts)", () => {
    expect(codes(strategyBriefing, { ...base, summary: "The pilot will cost 2.5 million." })).toContain("new_number");
    expect(codes(strategyBriefing, { ...base, summary: "Mid-market retention is 124%." })).toEqual([]);
  });

  it("does not treat candidate evidence as stated fact", () => {
    // teamPlanBriefing's "two sprints" estimate is a candidate excerpt; "Seven of the last ten" is approved but in words.
    const p = { ...base, emphasis: ["sec_tp_plan"], implications: [], summary: "Audit logging takes 2 sprints." };
    expect(codes(teamPlanBriefing, p)).toContain("new_number");
  });

  it("rejects duplicate labels, empty and malformed suggestions, and a full briefing", () => {
    expect(codes(strategyBriefing, { ...base, label: " finance " })).toContain("duplicate_label");
    expect(codes(strategyBriefing, base, { pendingLabels: ["DELIVERY"] })).toContain("duplicate_label");
    expect(codes(strategyBriefing, { ...base, summary: "", emphasis: [], implications: [] })).toContain("empty");
    expect(codes(strategyBriefing, { ...base, id: "not-an-id" })).toEqual(["invalid_schema"]);
    const full = { ...strategyBriefing, perspectives: Array.from({ length: 8 }, (_, i) => ({ ...base, id: `psp_full000${i}`, label: `P${i}` })) };
    expect(codes(full, { ...base, label: "Another" })).toContain("too_many_perspectives");
  });
});

describe("deterministic perspective suggestions", () => {
  it("suggests labelled, rule-based perspectives that pass validation", () => {
    const out = suggestPerspectivesDeterministic({ document: strategyBriefing, baseVersion: 3, maxSuggestions: 3 });
    // Finance already exists, so the next lenses apply.
    expect(out.suggestions.map((s) => s.perspective.label)).toEqual(["Decision makers", "Risk review", "Delivery"]);
    for (const s of out.suggestions) {
      expect(s.rationale).toMatch(/Rule-based suggestion from the local deterministic provider \(no model\)/);
      expect(validateSuggestedPerspective(strategyBriefing, s.perspective).ok).toBe(true);
    }
    const delivery = out.suggestions[2]!.perspective;
    expect(delivery.emphasis).toEqual(["sec_next_steps"]);
    expect(delivery.implications.map((i) => i.blockIds[0])).toEqual(["blk_next_timeline", "blk_action_criteria", "blk_action_pod"]);
  });

  it("is deterministic and respects the remaining capacity", () => {
    const a = suggestPerspectivesDeterministic({ document: strategyBriefing, baseVersion: 3, maxSuggestions: 8 });
    const b = suggestPerspectivesDeterministic({ document: strategyBriefing, baseVersion: 3, maxSuggestions: 8 });
    expect(a).toEqual(b);
    expect(a.suggestions.length).toBe(4);
    const nearlyFull = { ...strategyBriefing, perspectives: [...strategyBriefing.perspectives, ...Array.from({ length: 5 }, (_, i) => ({ ...base, id: `psp_more000${i}`, label: `X${i}` }))] };
    expect(suggestPerspectivesDeterministic({ document: nearlyFull, maxSuggestions: 3 }).suggestions).toHaveLength(1);
  });

  it("explains when nothing applies", () => {
    const bare = { ...strategyBriefing, sections: [{ id: "sec_only", title: "Only", blocks: [] }], perspectives: [] };
    const out = suggestPerspectivesDeterministic({ document: bare, maxSuggestions: 3 });
    expect(out.suggestions).toEqual([]);
    expect(out.notes).toMatch(/No rule-based suggestions apply/);
  });

  it("runs through the task contract on the DeterministicProvider", async () => {
    const res = await runTask(new DeterministicProvider(), SuggestPerspectivesTask, { document: strategyBriefing, maxSuggestions: 2 }, { timeoutMs: 1000 });
    expect(res.ok && res.output.suggestions).toHaveLength(2);
    expect(res.record).toMatchObject({ task: "suggest_perspectives", provider: "deterministic", promptVersion: "suggest_perspectives.v1" });
  });

  it("has a model prompt that keeps the document in a data block and names the D06 rules", () => {
    const { system, prompt } = suggestPerspectivesPrompt({ document: strategyBriefing, maxSuggestions: 3 });
    expect(system).toMatch(/never adds, removes, hides or changes facts/);
    expect(system).toMatch(/"Finance", "Operations"/);
    expect(prompt).toMatch(/^<data name="document">/);
  });
});
