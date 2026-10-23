import { describe, expect, it } from "vitest";
import { GAP_PLACEHOLDERS, collectIssues, markdownToDocument, parseActionLine, sequentialIds } from "./index";

const md = `# Our next chapter: a focused move upmarket

Win larger customers by focusing on the mid-market.

Some background on how we got here.

## Why now

Our strongest retention comes from customers with 100–1,000 employees.

Decision: Approve a 90-day mid-market pilot.

## Tradeoffs

- Risk: Support capacity is exceeded.
- Assumption: Pricing tiers are acceptable.
**Tradeoff:** Two roadmap items slip.

### Detail

We considered:
- Enterprise now
- Stay the course

## Next steps

- [ ] Draft stop-or-scale criteria (owner: Maya Chen, due: 2026-11-13)
- [x] Already done
Action: Nominate pod members — owner: Alex Rivera
`;

describe("markdownToDocument", () => {
  it("maps headings, paragraphs, actions, risks and the request deterministically", () => {
    const a = markdownToDocument(md, { ids: sequentialIds() });
    const b = markdownToDocument(md, { ids: sequentialIds() });
    expect(a).toEqual(b);
    const { document, gaps } = a;

    expect(document.title).toBe("Our next chapter: a focused move upmarket");
    expect(document.position.summary).toBe("Win larger customers by focusing on the mid-market.");
    expect(document.sections.map((s) => s.title)).toEqual(["Overview", "Why now", "Tradeoffs", "Next steps"]);
    expect(document.context.stakes).toBe("Our strongest retention comes from customers with 100–1,000 employees.");
    expect(document.request).toEqual({ type: "decision", statement: "Approve a 90-day mid-market pilot." });

    const [, why, tradeoffs, next] = document.sections;
    expect(why!.blocks.map((b) => b.type)).toEqual(["narrative", "decision"]);
    expect(why!.blocks[0]).toMatchObject({ role: "context" });
    expect(tradeoffs!.blocks.map((b) => (b.type === "risk" ? b.kind : b.type))).toEqual([
      "risk",
      "assumption",
      "tradeoff",
      "narrative",
      "narrative",
    ]);
    expect(tradeoffs!.blocks[4]).toMatchObject({ text: "We considered:\n- Enterprise now\n- Stay the course" });
    expect(next!.blocks).toEqual([
      expect.objectContaining({
        type: "action",
        statement: "Draft stop-or-scale criteria",
        owner: "Maya Chen",
        dueDate: "2026-11-13",
      }),
      expect.objectContaining({ type: "narrative", text: "- [x] Already done" }),
      expect.objectContaining({ type: "action", statement: "Nominate pod members", owner: "Alex Rivera" }),
    ]);
    expect(next!.blocks[2]).not.toHaveProperty("dueDate");

    expect(gaps).toEqual([expect.stringMatching(/no supporting evidence attached/)]);
    expect(collectIssues(document).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reports gaps and uses placeholders when parts are missing", () => {
    const { document, gaps } = markdownToDocument("## Notes\n\nJust some notes.", { ids: sequentialIds() });
    expect(document.title).toBe(GAP_PLACEHOLDERS.title);
    expect(document.position.summary).toBe(GAP_PLACEHOLDERS.summary);
    expect(document.context.stakes).toBe(GAP_PLACEHOLDERS.stakes);
    expect(document.request.statement).toBe(GAP_PLACEHOLDERS.request);
    expect(document.evidence).toEqual([]);
    expect(gaps.length).toBeGreaterThanOrEqual(5);
  });

  it("uses opts.title only when there is no # heading", () => {
    expect(markdownToDocument("Body.", { title: "Fallback" }).document.title).toBe("Fallback");
    expect(markdownToDocument("# Real\n\nBody.", { title: "Fallback" }).document.title).toBe("Real");
  });

  it("parses owner and due only when written", () => {
    expect(parseActionLine("Ship it")).toEqual({ statement: "Ship it" });
    expect(parseActionLine("Ship it, owner: Sam Taylor, due 2026-12")).toEqual({
      statement: "Ship it",
      owner: "Sam Taylor",
      dueDate: "2026-12",
    });
  });
});
