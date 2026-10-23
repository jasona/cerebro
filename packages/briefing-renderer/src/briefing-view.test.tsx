import { strategyBriefing, toPublishedDocument, type BriefingDocument } from "@cerebro/briefing-schema/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BriefingOutline, BriefingView, Chart, EvidenceList, estimateReadingMinutes, RichText } from "./index";
import { localStrategyBriefing } from "./test-fixture";

const fixtures: Array<[string, BriefingDocument]> = [
  ["local strategy fixture", localStrategyBriefing],
  ["shared strategy fixture (published projection)", toPublishedDocument(strategyBriefing).document],
  ["shared strategy fixture (draft)", strategyBriefing],
];

const html = (el: React.ReactElement) => renderToString(el);

describe.each(fixtures)("BriefingView with %s", (_name, doc) => {
  it("renders the position, request and every section with deep-link ids", () => {
    const out = html(<BriefingView document={doc} mode="reader" revision={{ number: 3, publishedAt: "2026-10-22" }} author={{ name: "Jason Lee" }} />);
    expect(out).toContain("<h1");
    expect(out).toContain(escape(doc.position.headline));
    expect(out).toContain(escape(doc.request.statement));
    expect(out).toMatch(/The decision|Approval requested|Input requested|For your awareness/);
    for (const s of doc.sections) {
      expect(out).toContain(`id="${s.id}"`);
      for (const b of s.blocks) expect(out).toContain(`id="${b.id}"`);
    }
    expect(out).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders in preview mode", () => {
    const out = html(<BriefingView document={doc} mode="preview" />);
    expect(out).toContain("Preview.");
  });

  it("renders the outline with numbered section links", () => {
    const out = html(<BriefingOutline document={doc} />);
    for (const s of doc.sections) expect(out).toContain(`href="#${s.id}"`);
    expect(out).toContain(">01<");
    expect(out).toContain("min read");
  });
});

const doc = localStrategyBriefing;

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

describe("RichText", () => {
  it("escapes HTML and scripts", () => {
    const out = html(<RichText text={'<script>alert(1)</script> <img src=x onerror="alert(2)"> **ok**'} />);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<strong");
  });

  it("drops javascript:, data: and other non-http(s) link targets", () => {
    const out = html(
      <RichText text={"[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,x) [d](vbscript:x) [e](/relative)"} />,
    );
    expect(out).not.toMatch(/href=/);
    expect(out.toLowerCase()).not.toContain("javascript:alert");
    expect(out).toContain(">a ");
  });

  it("supports bold, italic, safe links and paragraphs", () => {
    const out = html(<RichText text={"First **bold** and _it_ with [site](https://example.com/x?a=1&b=2).\n\nSecond snake_case_word"} />);
    expect(out.match(/<p/g)).toHaveLength(2);
    expect(out).toContain("<em>it</em>");
    expect(out).toContain('href="https://example.com/x?a=1&amp;b=2"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("snake_case_word");
  });
});

describe("Chart", () => {
  const chart = doc.sections.flatMap((s) => s.blocks).find((b) => b.type === "chart" && b.kind === "bar");
  const line = doc.sections.flatMap((s) => s.blocks).find((b) => b.type === "chart" && b.kind === "line");
  if (chart?.type !== "chart" || line?.type !== "chart") throw new Error("fixture needs bar and line charts");

  it.each([
    ["bar", chart],
    ["line", line],
  ] as const)("%s chart renders an accessible SVG, alt text and a data table", (_k, block) => {
    const out = html(<Chart block={block} />);
    expect(out).toContain('role="img"');
    expect(out).toContain(`aria-describedby="${block.id}-chart-desc"`);
    expect(out).toContain(escape(block.altText));
    expect(out).toContain("<details");
    expect(out).toContain("<table");
    expect(out).toContain('scope="row"');
    for (const s of block.series) expect(out).toContain(escape(s.label));
  });

  it("labels bar values in text, not only by colour", () => {
    const out = html(<Chart block={chart} />);
    expect(out).toContain("124%");
    expect(out).toContain("96%");
  });
});

describe("perspectives", () => {
  it("labels emphasised sections without removing any section", () => {
    const base = html(<BriefingView document={doc} mode="reader" />);
    const finance = html(<BriefingView document={doc} mode="reader" perspectiveId="psp_finance" perspectiveHref={(id) => (id ? `?perspective=${id}` : "?")} />);
    expect(finance).toContain("Emphasised for Finance");
    expect(finance).toContain('data-emphasised="true"');
    expect(finance).toContain("Reading for Finance");
    expect(finance).toContain("Budget is capped for 90 days.");
    expect(base).not.toContain("Emphasised for");
    for (const s of doc.sections) {
      expect(finance).toContain(`id="${s.id}"`);
      expect(base).toContain(`id="${s.id}"`);
    }
    expect(finance).toContain('href="?perspective=psp_finance"');
    expect(finance).toMatch(/aria-current="true"[^>]*>Finance</);
  });

  it("ignores unknown perspective ids", () => {
    const out = html(<BriefingView document={doc} mode="reader" perspectiveId="psp_missing" />);
    expect(out).not.toContain("Emphasised for");
  });
});

describe("evidence", () => {
  it("renders numbered markers with accessible names and in-page targets", () => {
    const out = html(<BriefingView document={doc} mode="reader" />);
    expect(out).toContain('aria-label="Evidence 1: Customer cohort analysis"');
    expect(out).toContain('href="#evidence-ev_cohort"');
    expect(out).toContain('id="evidence-ev_cohort"');
    expect(out).toContain("<blockquote");
  });

  it("uses the app's evidence href builder", () => {
    const out = html(<BriefingView document={doc} mode="reader" evidenceHref={(id) => `/e/${id}`} />);
    expect(out).toContain('href="/e/ev_cohort"');
  });

  it("hides candidate and excluded evidence from readers but shows candidates in preview", () => {
    const draft: BriefingDocument = {
      ...doc,
      evidence: [
        { ...doc.evidence[0]!, status: "approved" },
        { ...doc.evidence[1]!, status: "candidate" },
        { id: "ev_private", title: "Private notes", excerpt: "secret", origin: "manual", status: "excluded" },
      ],
    };
    const reader = html(<EvidenceList document={draft} mode="reader" />);
    expect(reader).not.toContain("Implementation review");
    expect(reader).not.toContain("secret");
    const preview = html(<EvidenceList document={draft} mode="preview" />);
    expect(preview).toContain("Implementation review");
    expect(preview).toContain("Not yet approved");
    expect(preview).not.toContain("secret");
  });

  it("shows an explicit empty state when no evidence is attached", () => {
    const out = html(<EvidenceList document={{ ...doc, evidence: [] }} />);
    expect(out).toContain("No supporting evidence attached");
  });
});

describe("slots", () => {
  it("renders block actions and preview annotations", () => {
    const out = html(
      <BriefingView
        document={doc}
        mode="preview"
        renderBlockActions={(b) => <button type="button">{`Ask about ${b.id}`}</button>}
        annotations={{ blk_compare: "Publishing without evidence" }}
      />,
    );
    expect(out).toContain("Ask about blk_rec_text");
    expect(out).toContain("Publishing without evidence");
  });

  it("marks the chosen decision option with text", () => {
    const out = html(<BriefingView document={doc} mode="reader" />);
    expect(out).toContain("Chosen");
    expect(out).toContain("Considered");
  });

  it("renders open questions", () => {
    const out = html(<BriefingView document={doc} mode="reader" />);
    expect(out).toContain('id="open-questions"');
    expect(out).toContain("Which regions should the pilot cover?");
  });
});

describe("estimateReadingMinutes", () => {
  it("returns at least one minute and grows with content", () => {
    expect(estimateReadingMinutes(doc)).toBeGreaterThanOrEqual(1);
    const long = { ...doc, context: { ...doc.context, stakes: "word ".repeat(2300) } };
    expect(estimateReadingMinutes(long)).toBeGreaterThanOrEqual(10);
  });
});
