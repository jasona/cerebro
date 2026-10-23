import { strategyBriefing, type BriefingDocument } from "@cerebro/briefing-schema/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText, richTextToPlain } from "./rich-text";
import { editorDocKey, editorDocToRichText, richTextToEditorDoc, type EditorDoc } from "./rich-text-doc";
import { localStrategyBriefing } from "./test-fixture";

const toDoc = richTextToEditorDoc;
const toText = editorDocToRichText;
const render = (text: string) => renderToString(<RichText text={text} />);
const p = (...content: NonNullable<EditorDoc["content"][number]["content"]>) => ({ type: "paragraph" as const, content });
const doc = (...content: EditorDoc["content"]): EditorDoc => ({ type: "doc", content });

/** Every field stored as RichText (or rendered with it) in a briefing document. */
function richTextFields(d: BriefingDocument): string[] {
  const out = [d.position.summary, d.context.stakes, d.context.background, d.request.detail, ...d.perspectives.map((x) => x.summary)];
  for (const s of d.sections)
    for (const b of s.blocks) {
      if (b.type === "narrative") out.push(b.text);
      if (b.type === "key_finding") out.push(b.detail);
      if (b.type === "decision") out.push(b.rationale);
    }
  return out.filter((x): x is string => !!x);
}

// Canonical strings round-trip byte for byte.
const CANONICAL = [
  "",
  "One paragraph.",
  "First paragraph.\n\nSecond paragraph.",
  "Line one\nline two",
  "A **bold** word and an _italic_ one.",
  "**_both_** and **bold with _italic_ inside**",
  "See [the plan](https://example.com/plan) for detail.",
  "[**bold label**](https://example.com/) then text",
  "[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
  "snake_case_names stay literal",
  "**Gross margin** fell to 41% (_Q3_), see [cohort data](https://example.com/q3?x=1&y=2).",
];

// Non-canonical input: same rendering after a round trip, then stable.
const NON_CANONICAL = [
  "  leading and trailing  \n\n\n\n  spaces  ",
  "_**italic outside bold**_",
  "**a****b**",
  "**bold across\nlines**",
  "[bad](javascript:alert(1)) link dropped",
  "Unclosed **bold and _italic",
  "Line\r\nendings\r\n\r\nnormalised",
];

describe("richTextToEditorDoc", () => {
  it("maps paragraphs, hard breaks and marks", () => {
    expect(toDoc("Hello **bold** _it_\nnext\n\n[link](https://example.com)")).toEqual(
      doc(
        p(
          { type: "text", text: "Hello " },
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " " },
          { type: "text", text: "it", marks: [{ type: "italic" }] },
          { type: "hardBreak" },
          { type: "text", text: "next" },
        ),
        p({ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] }),
      ),
    );
  });

  it("nests marks inside links and bold", () => {
    expect(toDoc("[**a** b](https://example.com/)")).toEqual(
      doc(
        p(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "https://example.com/" } }, { type: "bold" }] },
          { type: "text", text: " b", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
        ),
      ),
    );
  });

  it("returns one empty paragraph for empty text", () => {
    expect(toDoc("")).toEqual(doc({ type: "paragraph" }));
    expect(toDoc("  \n\n  ")).toEqual(doc({ type: "paragraph" }));
  });

  it("never produces unsafe links", () => {
    const json = JSON.stringify(toDoc("[x](javascript:alert(1)) [y](data:text/html,hi) [z](ftp://example.com)"));
    expect(json).not.toContain('"link"');
  });
});

describe("editorDocToRichText", () => {
  it.each(CANONICAL)("round-trips canonical text exactly: %j", (text) => {
    expect(toText(toDoc(text))).toBe(text);
  });

  it.each(NON_CANONICAL)("preserves the formatted text of %j and is then stable", (text) => {
    const once = toText(toDoc(text));
    // Same text and marks; mark nesting order may be canonicalised.
    expect(richTextToPlain(once)).toBe(richTextToPlain(text));
    expect(toText(toDoc(once))).toBe(once);
    expect(editorDocKey(toDoc(once))).toBe(editorDocKey(toDoc(text)));
  });

  it("round-trips every rich-text field of the fixtures without changing the rendering", () => {
    const fields = [...richTextFields(strategyBriefing), ...richTextFields(localStrategyBriefing)];
    expect(fields.length).toBeGreaterThan(5);
    for (const text of fields) {
      const once = toText(toDoc(text));
      expect(render(once), text).toBe(render(text));
      expect(toText(toDoc(once))).toBe(once);
    }
  });

  it("writes marks in canonical order whatever order the editor lists them", () => {
    const href = "https://example.com/";
    expect(
      toText(
        doc(
          p(
            { type: "text", text: "all", marks: [{ type: "italic" }, { type: "bold" }, { type: "link", attrs: { href, target: "_blank" } }] },
            { type: "text", text: " bold link", marks: [{ type: "bold" }, { type: "link", attrs: { href } }] },
          ),
        ),
      ),
    ).toBe(`[**_all_ bold link**](${href})`);
  });

  it("writes hard breaks as single newlines and drops empty paragraphs", () => {
    expect(toText(doc(p({ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }), { type: "paragraph" }, p({ type: "text", text: "c" })))).toBe(
      "a\nb\n\nc",
    );
    expect(toText(doc({ type: "paragraph" }))).toBe("");
  });

  it("keeps a mark open across a hard break when both sides share it", () => {
    const bold = [{ type: "bold" as const }];
    expect(toText(doc(p({ type: "text", text: "a", marks: bold }, { type: "hardBreak" }, { type: "text", text: "b", marks: bold })))).toBe("**a\nb**");
    expect(toText(doc(p({ type: "text", text: "a", marks: bold }, { type: "hardBreak" }, { type: "text", text: "b" })))).toBe("**a**\nb");
    // Link labels cannot span lines.
    const link = [{ type: "link" as const, attrs: { href: "https://example.com/" } }];
    expect(toText(doc(p({ type: "text", text: "a", marks: link }, { type: "hardBreak" }, { type: "text", text: "b", marks: link })))).toBe(
      "[a](https://example.com/)\n[b](https://example.com/)",
    );
  });

  it("drops italic the syntax cannot express (inside a word) rather than leaking underscores", () => {
    const text = toText(doc(p({ type: "text", text: "test" }, { type: "text", text: "ing", marks: [{ type: "italic" }] })));
    expect(text).toBe("testing");
  });

  it("only writes http(s) links, and encodes parentheses the syntax cannot hold", () => {
    expect(toText(doc(p({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] })))).toBe("x");
    const out = toText(doc(p({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://example.com/a((b))" } }] })));
    expect(out).toBe("[x](https://example.com/a%28%28b%29%29)");
    expect(toDoc(out).content[0]!.content![0]).toMatchObject({ marks: [{ type: "link" }] });
  });

  it("keeps the label but drops the target when the label contains ']'", () => {
    expect(toText(doc(p({ type: "text", text: "a]b", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] })))).toBe("a]b");
  });

  it("ignores unknown nodes and tolerates a missing content array", () => {
    expect(toText({ content: undefined })).toBe("");
    expect(toText({ content: [{ type: "heading", content: [{ type: "text", text: "x" }] }, p({ type: "text", text: "y" })] })).toBe("y");
  });
});
