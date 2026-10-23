import { describe, expect, it } from "vitest";
import {
  GAP_PLACEHOLDERS,
  HANDOFF_SECTION_TITLES,
  canonicalJson,
  collectIssues,
  handoffToDocument,
  parseHandoff,
  sampleHandoff,
  sequentialIds,
  strategyBriefing,
  type HandoffPackageInput,
} from "./index";

const numbersIn = (text: string) => new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);

describe("handoffToDocument", () => {
  it("uses a supplied document without rewriting content, resetting evidence to candidates", () => {
    const { document, gaps } = handoffToDocument({ handoffVersion: 1, document: strategyBriefing });
    const { evidence: _e1, ...restOut } = document;
    const { evidence: _e2, ...restIn } = strategyBriefing;
    expect(canonicalJson(restOut)).toBe(canonicalJson(restIn));
    expect(document.evidence.map((e) => e.excerpt)).toEqual(strategyBriefing.evidence.map((e) => e.excerpt));
    expect(document.evidence.every((e) => e.status === "candidate" && e.origin === "llm_handoff")).toBe(true);
    expect(gaps.join("\n")).toMatch(/reset to candidate/);
  });

  it("composes the sample handoff into the documented sections", () => {
    const { document, gaps } = handoffToDocument(sampleHandoff, { ids: sequentialIds() });
    expect(document.sections.map((s) => s.title)).toEqual([
      HANDOFF_SECTION_TITLES.recommendation,
      HANDOFF_SECTION_TITLES.why_now,
      HANDOFF_SECTION_TITLES.rationale,
      HANDOFF_SECTION_TITLES.risks,
      HANDOFF_SECTION_TITLES.next_steps,
    ]);
    const [rec, why, rationale, risks, next] = document.sections;
    expect(rec!.blocks[0]).toMatchObject({ type: "decision", statement: sampleHandoff.request!.statement });
    expect(rec!.blocks[0]!.type === "decision" && rec!.blocks[0]!.options.map((o) => o.chosen)).toEqual([true, false]);
    expect(why!.blocks[0]).toMatchObject({ type: "narrative", role: "context" });
    expect(why!.blocks[0]!.evidenceRefs).toHaveLength(1);
    expect(rationale!.blocks.map((b) => b.type)).toEqual(["narrative", "comparison"]);
    const cmp = rationale!.blocks[1]!;
    expect(cmp.type === "comparison" && cmp.columns).toEqual(["Pros", "Cons"]);
    expect(risks!.blocks.map((b) => (b.type === "risk" ? b.kind : b.type))).toEqual(["risk", "assumption"]);
    // Owners and dates only where supplied.
    expect(next!.blocks).toEqual([
      expect.objectContaining({ type: "action", owner: "Jordan Ellis" }),
      expect.not.objectContaining({ owner: expect.anything() }),
    ]);
    expect(next!.blocks.some((b) => b.type === "action" && b.dueDate)).toBe(false);
    expect(gaps).toContain("Some actions have no owner; owners were not inferred.");

    // Evidence: candidates from the handoff; URL kept as attribution metadata.
    expect(document.evidence.every((e) => e.status === "candidate" && e.origin === "llm_handoff")).toBe(true);
    expect(document.evidence[1]!.locator).toBe("https://chatgpt.com/c/example-conversation");
    // Perspective emphasis resolved to composed section ids.
    expect(document.perspectives[0]!.emphasis).toEqual([rec!.id, risks!.id]);
    expect(document.openQuestions.map((q) => q.text)).toEqual(sampleHandoff.openQuestions);
    expect(collectIssues(document).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reports gaps with clearly marked placeholders and never invents numbers or evidence", () => {
    const pkg: HandoffPackageInput = {
      handoffVersion: 1,
      title: "Hiring plan",
      rationale: "We need two more engineers to hit the roadmap.",
      actions: [{ statement: "Open the requisitions." }],
    };
    const { document, gaps } = handoffToDocument(pkg, { ids: sequentialIds() });

    expect(document.context.stakes).toBe(GAP_PLACEHOLDERS.stakes);
    expect(document.context.stakes).toBe("Not yet stated — add why this matters now.");
    expect(document.position.summary).toBe(GAP_PLACEHOLDERS.summary);
    expect(document.request).toEqual({ type: "awareness", statement: GAP_PLACEHOLDERS.request });
    expect(document.evidence).toEqual([]);
    expect(gaps.join("\n")).toMatch(/stakes/i);
    expect(gaps.join("\n")).toMatch(/No request/);
    expect(gaps.join("\n")).toMatch(/no supporting evidence attached/);

    // No numbers appear that were not in the input.
    const inputNumbers = numbersIn(JSON.stringify(pkg));
    const outputText = JSON.stringify({ ...document, schemaVersion: undefined });
    for (const n of numbersIn(outputText.replace(/"(?:blk|sec|ev|psp|itm)_\d+"/g, ""))) {
      expect(inputNumbers).toContain(n);
    }
    // No metrics or charts are fabricated.
    const types = document.sections.flatMap((s) => s.blocks.map((b) => b.type));
    expect(types).not.toContain("metric");
    expect(types).not.toContain("chart");
    // Placeholders surface as unresolved-gap warnings, not errors.
    const issues = collectIssues(document, { mode: "publish" });
    expect(issues.filter((i) => i.code === "unresolved_gap").map((i) => i.path)).toEqual(
      expect.arrayContaining(["$.context.stakes", "$.request.statement", "$.position.summary"]),
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("composes from selected content alone via markdown", () => {
    const { document, gaps } = handoffToDocument(
      {
        handoffVersion: 1,
        selectedContent: "# Pricing update\n\nWe will simplify pricing.\n\n## Why now\n\nCompetitors moved first.\n\nDecision: Approve the new tiers.",
      },
      { ids: sequentialIds() },
    );
    expect(document.title).toBe("Pricing update");
    expect(document.request).toMatchObject({ type: "decision", statement: "Approve the new tiers." });
    expect(gaps[0]).toMatch(/composed from the selected content/);
  });

  it("parseHandoff reports structured issues", () => {
    const result = parseHandoff({ handoffVersion: 2, evidence: [{ title: "x" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["$.handoffVersion", "$.evidence[0].excerpt"]),
    );
  });
});
