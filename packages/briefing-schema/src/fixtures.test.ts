import { describe, expect, it } from "vitest";
import {
  BriefingDocument,
  HandoffPackage,
  briefingDocumentJsonSchema,
  collectIssues,
  handoffJsonSchema,
  newId,
  parseDocument,
  sampleHandoff,
  strategyBriefing,
  teamPlanBriefing,
  ID_PREFIXES,
} from "./index";

describe("fixtures", () => {
  it.each([
    ["strategyBriefing", strategyBriefing],
    ["teamPlanBriefing", teamPlanBriefing],
  ])("%s parses and has no errors in either mode", (_name, doc) => {
    expect(parseDocument(doc).ok).toBe(true);
    for (const mode of ["draft", "publish"] as const) {
      expect(collectIssues(doc, { mode }).filter((i) => i.severity === "error")).toEqual([]);
    }
  });

  it("strategy briefing has no issues at all and matches the concept", () => {
    expect(collectIssues(strategyBriefing, { mode: "publish" })).toEqual([]);
    expect(strategyBriefing.sections.map((s) => s.title)).toEqual([
      "The recommendation",
      "Why now",
      "The evidence",
      "Tradeoffs",
      "Next steps",
    ]);
    expect(strategyBriefing.request.statement).toBe("Approve a 90-day mid-market pilot.");
    expect(strategyBriefing.perspectives.map((p) => p.label)).toEqual(["Finance", "Operations"]);
    expect(strategyBriefing.evidence.every((e) => e.status === "approved")).toBe(true);
    const types = new Set(strategyBriefing.sections.flatMap((s) => s.blocks.map((b) => b.type)));
    for (const t of ["chart", "metric", "comparison", "timeline", "risk", "action", "decision"]) expect(types).toContain(t);
    const chart = strategyBriefing.sections.flatMap((s) => s.blocks).find((b) => b.type === "chart");
    expect(chart?.type === "chart" && chart.caption).toMatch(/illustrative/i);
    expect(strategyBriefing.evidence.every((e) => /fictional/.test(e.attribution ?? ""))).toBe(true);
  });

  it("sample handoff is a valid HandoffPackage", () => {
    const pkg = HandoffPackage.parse(sampleHandoff);
    expect(pkg.destination?.label).toBe("Platform team");
    expect(pkg.audience?.visibility).toBe("company");
  });
});

describe("ids", () => {
  it("generates prefixed 12-char base62 ids accepted by the schema", () => {
    const seen = new Set<string>();
    for (const prefix of ID_PREFIXES) {
      for (let i = 0; i < 200; i++) {
        const id = newId(prefix);
        expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-Za-z]{12}$`));
        seen.add(id);
      }
    }
    expect(seen.size).toBe(ID_PREFIXES.length * 200);
    expect(() =>
      BriefingDocument.shape.sections.parse([{ id: newId("sec"), title: "x", blocks: [] }]),
    ).not.toThrow();
  });
});

describe("json schema", () => {
  it("emits object schemas for the document and handoff", () => {
    const doc = briefingDocumentJsonSchema();
    expect(doc.type).toBe("object");
    expect(Object.keys(doc.properties as object)).toContain("sections");
    // Input mode: defaulted fields are not required.
    expect(doc.required).not.toContain("perspectives");
    const handoff = handoffJsonSchema();
    expect(Object.keys(handoff.properties as object)).toEqual(
      expect.arrayContaining(["handoffVersion", "evidence", "document", "target", "audience"]),
    );
    expect(handoff.required).toEqual(["handoffVersion"]);
    expect(() => JSON.stringify(handoff)).not.toThrow();
  });
});
