import { describe, expect, it } from "vitest";
import { BriefingDocument, sampleHandoff, strategyBriefing } from "@cerebro/briefing-schema";
import {
  ComposeTask,
  DeterministicProvider,
  LOCAL_PASSAGES,
  EVAL_REVISION_ID,
  ProposeRevisionTask,
  SummarizeTopicsTask,
  UNSUPPORTED_INSTRUCTION,
  applyRevisionOperations,
  extractNumbers,
  extractiveAnswer,
  passagesFromDocument,
  runTask,
} from "./index";

const provider = new DeterministicProvider();
const opts = { timeoutMs: 5_000 };

describe("extractive answers", () => {
  const input = (question: string) => ({ question, revisionId: EVAL_REVISION_ID, passages: [...LOCAL_PASSAGES] });

  it("answers from verbatim sentences and cites them", () => {
    const out = extractiveAnswer(input("When are the legacy platforms retired?"));
    expect(out.status).toBe("answered");
    for (const part of out.answer) {
      expect(part.kind).toBe("stated");
      const cited = LOCAL_PASSAGES.find((p) => p.id === part.citations[0]);
      expect(cited?.text).toContain(part.text);
    }
    expect(out.citations.map((c) => c.passageId)).toContain("blk_migration0001");
  });

  it("abstains and names uncovered terms", () => {
    const out = extractiveAnswer(input("What is the hiring plan for the European sales team?"));
    expect(out.status).toBe("insufficient");
    expect(out.answer).toEqual([]);
    expect(out.missing).toMatch(/European/);
  });

  it("is deterministic", () => {
    const q = input("What did surveyed customers prefer?");
    expect(extractiveAnswer(q)).toEqual(extractiveAnswer(q));
  });

  it("only emits numbers present in cited passages", () => {
    for (const q of ["What does the migration cost?", "How many engineers are on the migration team?", "What share of incidents came from drift?"]) {
      const out = extractiveAnswer(input(q));
      for (const part of out.answer) {
        const text = part.citations.map((id) => LOCAL_PASSAGES.find((p) => p.id === id)!.text).join(" ");
        for (const n of extractNumbers(part.text)) expect(extractNumbers(text)).toContain(n);
      }
    }
  });

  it("answers over the representative strategy briefing", () => {
    const passages = passagesFromDocument(strategyBriefing, "rev_1");
    expect(passages.some((p) => p.kind === "evidence")).toBe(true);
    const out = extractiveAnswer({ question: strategyBriefing.position.headline, revisionId: "rev_1", passages });
    expect(out.status).toBe("answered");
  });
});

describe("passage projection", () => {
  it("never includes candidate or excluded evidence", () => {
    const doc = BriefingDocument.parse({
      ...strategyBriefing,
      evidence: [
        { id: "ev_ok000001", title: "Approved", excerpt: "approved text", status: "approved" },
        { id: "ev_no000001", title: "Candidate", excerpt: "candidate text", status: "candidate" },
        { id: "ev_no000002", title: "Excluded", excerpt: "excluded text", status: "excluded" },
      ],
      sections: [],
    });
    const ids = passagesFromDocument(doc, "rev_1").map((p) => p.id);
    expect(ids).toContain("ev_ok000001");
    expect(ids).not.toContain("ev_no000001");
    expect(ids).not.toContain("ev_no000002");
  });
});

describe("compose", () => {
  it("maps Markdown without inventing content and adds sources as candidates", async () => {
    const res = await runTask(provider, ComposeTask, {
      handoffText: "# Platform consolidation\n\nConsolidate onto one platform.\n\n## Why now\n\nDuplicated work is expensive.",
      sources: [{ id: "src-1", title: "Ops review", text: "Incidents doubled.", origin: "llm_handoff" }],
      desiredOutcome: "Approve the consolidation plan",
    }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { document, gaps, sourceRefs } = res.output;
    expect(document.title).toBe("Platform consolidation");
    expect(document.request.statement).toBe("Approve the consolidation plan");
    expect(document.request.type).toBe("approval");
    const ev = document.evidence.find((e) => e.id === sourceRefs[0]?.evidenceId);
    expect(ev?.status).toBe("candidate");
    expect(gaps.some((g) => g.kind === "unverified_attribution")).toBe(true);
    expect(gaps.some((g) => g.kind === "missing_request")).toBe(false);
  });

  it("keeps a valid structured draft as written", async () => {
    const res = await runTask(provider, ComposeTask, { structuredDraft: strategyBriefing }, opts);
    expect(res.ok && res.output.document).toEqual(strategyBriefing);
  });

  it("composes from a handoff package", async () => {
    const res = await runTask(provider, ComposeTask, { handoff: sampleHandoff }, opts);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output.document.position.headline).toBe(sampleHandoff.position?.headline);
  });

  it("returns a gap-marked scaffold for empty input", async () => {
    const res = await runTask(provider, ComposeTask, {}, opts);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.document.position.headline).toMatch(/^Not yet stated/);
      expect(res.output.gaps.length).toBeGreaterThan(0);
    }
  });
});

describe("propose revision", () => {
  const doc = strategyBriefing;

  it("adds an empty perspective scaffold flagged as a gap", async () => {
    const res = await runTask(provider, ProposeRevisionTask, { document: doc, instruction: "Add a perspective for finance leadership", baseVersion: 7 }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.status).toBe("proposed");
    expect(res.output.baseVersion).toBe(7);
    const op = res.output.operations?.[0];
    expect(op?.op).toBe("add_perspective");
    if (op?.op !== "add_perspective") return;
    expect(op.perspective.label).toBe("Finance Leadership");
    expect(op.perspective.summary).toBe("");
    expect(res.output.gaps[0]?.kind).toBe("empty_perspective");
    const next = applyRevisionOperations(doc, res.output.operations ?? []);
    expect(next.perspectives).toHaveLength(doc.perspectives.length + 1);
  });

  it("treats tighten as an explained no-op", async () => {
    const res = await runTask(provider, ProposeRevisionTask, { document: doc, instruction: "Tighten the recommendation" }, opts);
    expect(res.ok && res.output.status).toBe("no_change");
    expect(res.ok && res.output.operations).toEqual([]);
  });

  it("reports other instructions as unsupported", async () => {
    const res = await runTask(provider, ProposeRevisionTask, { document: doc, instruction: "Rewrite the stakes for a board audience" }, opts);
    expect(res.ok && res.output.status).toBe("unsupported");
    expect(res.ok && res.output.explanation).toBe(UNSUPPORTED_INSTRUCTION);
  });
});

describe("topic summaries", () => {
  const questions = [
    { id: "q1", text: "When does pricing change for existing customers?", readerHash: "a" },
    { id: "q2", text: "Will pricing go up for enterprise?", readerHash: "b" },
    { id: "q3", text: "Is pricing tied to the new tiers?", readerHash: "c" },
    { id: "q4", text: "What is the migration timeline?", readerHash: "a" },
    { id: "q5", text: "Does the migration timeline slip if hiring lags?", readerHash: "a" },
    { id: "q6", text: "Who owns support?", readerHash: "d" },
  ];

  it("clusters by keyword deterministically with ids only", async () => {
    const res = await runTask(provider, SummarizeTopicsTask, { questions }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [first, second] = res.output.topics;
    expect(first).toMatchObject({ label: "Pricing", count: 3, distinctReaders: 3 });
    expect(second).toMatchObject({ count: 2, distinctReaders: 1 });
    expect(second?.label).toMatch(/^Migration/);
    expect(JSON.stringify(res.output)).not.toContain("enterprise");
    const again = await runTask(provider, SummarizeTopicsTask, { questions }, opts);
    expect(again.ok && again.output).toEqual(res.output);
  });

  it("suppresses topics below the distinct-reader threshold", async () => {
    const res = await runTask(provider, SummarizeTopicsTask, { questions, minDistinctReaders: 2 }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.topics.map((t) => t.label)).toEqual(["Pricing"]);
    expect(res.output.suppressedQuestions).toBe(3);
  });
});
