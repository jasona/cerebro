import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectKind, extractSource } from "../src";
import { buildDocx, buildPdf, buildPptx } from "./fixtures";

describe("PDF", () => {
  it("extracts per-page text with page locators and reports pages without a text layer", async () => {
    const bytes = buildPdf([["Revenue grew 12% in Q3.", "Churn fell."], null, ["Recommendation: expand to EMEA."]]);
    expect(detectKind("deck.bin", undefined, bytes)).toBe("pdf");
    const r = await extractSource({ kind: "pdf", bytes, filename: "memo.pdf" });
    expect(r.status).toBe("partial");
    expect(r.stats.pages).toBe(3);
    expect(r.chunks.map((c) => c.locator.label)).toEqual(["p. 1", "p. 3"]);
    expect(r.chunks[0]!.text).toContain("Revenue grew 12% in Q3.");
    expect(r.chunks[1]!.text).toContain("expand to EMEA");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "no_text_layer", message: "Page 2 has no text layer; OCR is not supported.", affectsCompleteness: true }));
    expect(r.chunks[0]!.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is complete when every page has text", async () => {
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([["One."], ["Two."]]) });
    expect(r.status).toBe("complete");
    expect(r.gaps).toEqual([]);
  });

  it("fails honestly for a scanned-looking PDF with no text at all", async () => {
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([null, null]) });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("no_extractable_text");
    expect(r.gaps.filter((g) => g.code === "no_text_layer")).toHaveLength(2);
  });

  it("reports truncation at the page limit", async () => {
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([["A."], ["B."], ["C."]]) }, { limits: { maxPages: 2 } });
    expect(r.status).toBe("partial");
    expect(r.chunks).toHaveLength(2);
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "truncated" }));
  });

  it("fails with corrupt_file for a damaged PDF", async () => {
    const r = await extractSource({ kind: "pdf", bytes: new TextEncoder().encode("%PDF-1.7\nthis is not really a pdf") });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("corrupt_file");
    expect(r.chunks).toEqual([]);
  });
});

describe("DOCX", () => {
  it("extracts paragraphs with paragraph locators", async () => {
    const bytes = await buildDocx(["Decision requested", "We should consolidate vendors.", "Savings: $1.2M & fewer contracts."]);
    expect(detectKind("x", undefined, bytes)).toBe("docx");
    const r = await extractSource({ kind: "docx", bytes });
    expect(r.status).toBe("complete");
    expect(r.stats.paragraphs).toBe(3);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.locator).toMatchObject({ kind: "paragraph", index: 1, endIndex: 3, label: "Paragraphs 1–3" });
    expect(r.chunks[0]!.text).toBe("Decision requested\n\nWe should consolidate vendors.\n\nSavings: $1.2M & fewer contracts.");
  });

  it("splits long documents into ~1,200 character chunks on paragraph boundaries", async () => {
    const para = (i: number) => `Paragraph ${i} ` + "explains the tradeoff in detail. ".repeat(10).trim();
    const paragraphs = Array.from({ length: 12 }, (_, i) => para(i + 1));
    const r = await extractSource({ kind: "docx", bytes: await buildDocx(paragraphs) });
    expect(r.chunks.length).toBeGreaterThan(2);
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(1_200);
    // Paragraph ranges are contiguous and cover every paragraph.
    let next = 1;
    for (const c of r.chunks) {
      expect(c.locator.index).toBe(next);
      next = (c.locator.endIndex ?? c.locator.index) + 1;
    }
    expect(next).toBe(13);
  });

  it("reports images as gaps and marks the result partial", async () => {
    const drawing = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const r = await extractSource({ kind: "docx", bytes: await buildDocx(["Text before the figure."], drawing) });
    expect(r.status).toBe("partial");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "image_not_extracted", affectsCompleteness: true }));
  });

  it("fails for a ZIP that is not a Word document", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", "<workbook/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(detectKind("book.xlsx", undefined, bytes)).toBeNull();
    const r = await extractSource({ kind: "docx", bytes });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("unsupported_format");
  });

  it("fails with corrupt_file for a truncated archive", async () => {
    const good = await buildDocx(["Hello"]);
    const r = await extractSource({ kind: "docx", bytes: good.subarray(0, Math.floor(good.length / 2)) });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("corrupt_file");
  });
});

describe("PPTX", () => {
  const deck = () =>
    buildPptx(
      [
        { title: "Expand to EMEA", body: ["Demand is proven", "Margins hold at scale"], notes: ["Mention the Berlin pilot."] },
        { picture: true },
        { title: "Revenue by region", body: ["See chart"], chart: true },
      ],
      [1, 2, 10],
    );

  it("extracts slide text in numeric order with titles and speaker notes", async () => {
    const bytes = await deck();
    expect(detectKind("deck.pptx", undefined, bytes)).toBe("pptx");
    const r = await extractSource({ kind: "pptx", bytes });
    expect(r.stats.slides).toBe(3);
    expect(r.status).toBe("partial");
    const labels = r.chunks.map((c) => c.locator.label);
    expect(labels).toEqual(["Slide 1", "Slide 1 notes", "Slide 3"]);
    expect(r.chunks[0]!.heading).toBe("Expand to EMEA");
    expect(r.chunks[0]!.text).toBe("Expand to EMEA\n\nDemand is proven\n\nMargins hold at scale");
    expect(r.chunks[1]!.locator.part).toBe("notes");
    expect(r.chunks[1]!.text).toBe("Mention the Berlin pilot.");
    expect(r.chunks[1]!.text).not.toContain("7"); // slide-number placeholder is skipped
    expect(r.chunks[2]!.heading).toBe("Revenue by region");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "image_only", message: "Slide 2 contains no extractable text (possibly an image).", affectsCompleteness: true }));
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "chart_not_extracted", locator: expect.objectContaining({ label: "Slide 3" }) }));
  });

  it("reports excluded speaker notes as a gap", async () => {
    const r = await extractSource({ kind: "pptx", bytes: await deck() }, { includeSpeakerNotes: false });
    expect(r.chunks.some((c) => c.locator.part === "notes")).toBe(false);
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "speaker_notes_excluded", message: expect.stringContaining("Speaker notes not included") }));
  });

  it("decodes XML entities and is complete for a text-only deck", async () => {
    const r = await extractSource({ kind: "pptx", bytes: await buildPptx([{ title: "R&D <2027>", body: ["\"Quoted\" & 'apos'"] }]) });
    expect(r.status).toBe("complete");
    expect(r.chunks[0]!.text).toBe("R&D <2027>\n\n\"Quoted\" & 'apos'");
  });

  it("rejects a DOCX declared as PPTX", async () => {
    const r = await extractSource({ kind: "pptx", bytes: await buildDocx(["x"]) });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("kind_mismatch");
  });
});
