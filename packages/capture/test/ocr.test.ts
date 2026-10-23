import { describe, expect, it, vi } from "vitest";
import { detectKind, extractSource, readImageHeader, validateUpload, type OcrEngine, type OcrEngineFactory, type OcrRecognition } from "../src";
import { buildPdf } from "./fixtures";
import { buildScannedPdf, pngHeaderOnly, textImage } from "./image-fixtures";

// Real OCR (tesseract.js + bundled English data) on images generated in-test.
const OCR_TIMEOUT = 60_000;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");

function fakeEngine(recognize: () => Promise<OcrRecognition>): { factory: OcrEngineFactory; calls: { created: number; recognized: number; terminated: number; languages?: readonly string[] } } {
  const calls = { created: 0, recognized: 0, terminated: 0, languages: undefined as readonly string[] | undefined };
  const factory: OcrEngineFactory = async ({ languages }) => {
    calls.created += 1;
    calls.languages = languages;
    const engine: OcrEngine = {
      recognize: () => {
        calls.recognized += 1;
        return recognize();
      },
      terminate: async () => {
        calls.terminated += 1;
      },
    };
    return engine;
  };
  return { factory, calls };
}

describe("image OCR", () => {
  it(
    "reads a PNG with an OCR-marked image locator",
    async () => {
      const bytes = await textImage(["Revenue grew twelve percent", "Expand to EMEA next quarter"]);
      expect(detectKind("whiteboard.bin", undefined, bytes)).toBe("image");
      expect(validateUpload({ kind: "image", bytes })).toEqual({ ok: true, kind: "image" });

      const r = await extractSource({ kind: "image", bytes, filename: "whiteboard.png" });
      expect(r.status).toBe("complete");
      expect(r.stats.ocrPages).toBe(1);
      expect(r.chunks).toHaveLength(1);
      const chunk = r.chunks[0]!;
      expect(words(chunk.text)).toContain("revenue grew twelve percent");
      expect(words(chunk.text)).toContain("expand to emea next quarter");
      expect(chunk.locator.kind).toBe("image");
      expect(chunk.locator.ocr?.confidence).toBeGreaterThanOrEqual(80);
      expect(chunk.locator.label).toMatch(/^Image \(OCR, \d{1,3}% confidence\)$/);
      // Machine-read text is flagged for the author; the gap carries no extracted text.
      const used = r.gaps.find((g) => g.code === "ocr_used")!;
      expect(used).toMatchObject({ affectsCompleteness: false, locator: { kind: "image" } });
      expect(used.message).not.toMatch(/revenue|emea/i);
    },
    OCR_TIMEOUT,
  );

  it(
    "reads JPEG and WebP images",
    async () => {
      for (const format of ["jpeg", "webp"] as const) {
        const bytes = await textImage(["Quarterly churn fell"], { format });
        expect(readImageHeader(bytes)).toMatchObject({ format, width: 1400, height: 200 });
        const r = await extractSource({ kind: "image", bytes });
        expect(r.status).toBe("complete");
        expect(words(r.chunks[0]!.text)).toContain("quarterly churn fell");
      }
    },
    OCR_TIMEOUT,
  );

  it("refuses an image whose header declares too many pixels, before decoding", async () => {
    const bytes = pngHeaderOnly(30_000, 30_000);
    const v = validateUpload({ kind: "image", bytes });
    expect(v).toMatchObject({ ok: false, error: { code: "too_large", limit: 50_000_000, actual: 900_000_000 } });
    const r = await extractSource({ kind: "image", bytes });
    expect(r).toMatchObject({ status: "failed", errorCategory: "too_large" });
    const small = await textImage(["x"]);
    expect(validateUpload({ kind: "image", bytes: small }, { maxImagePixels: 1000 })).toMatchObject({ ok: false, error: { code: "too_large" } });
  });

  it("rejects non-images, damaged headers and undecodable pixels honestly", async () => {
    expect(validateUpload({ kind: "image", bytes: buildPdf([["x"]]) })).toMatchObject({ ok: false, error: { code: "kind_mismatch" } });
    expect(validateUpload({ kind: "image", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) })).toMatchObject({ ok: false, error: { code: "corrupt_file" } });
    const r = await extractSource({ kind: "image", bytes: pngHeaderOnly(100, 100) });
    expect(r).toMatchObject({ status: "failed", errorCategory: "corrupt_file" });
  });

  it("reports an image as a gap when OCR is turned off", async () => {
    const r = await extractSource({ kind: "image", bytes: await textImage(["Hello"]) }, { ocr: { enabled: false } });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("no_extractable_text");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "image_not_extracted", affectsCompleteness: true }));
  });
});

describe("scanned PDF OCR", () => {
  it(
    "OCR-reads only pages without a text layer, keeping page locators",
    async () => {
      const bytes = buildScannedPdf([{ text: ["Decision requested: approve the pilot."] }, { scan: ["Scanned appendix", "Budget approved in March"] }, { blank: true }]);
      const r = await extractSource({ kind: "pdf", bytes });
      expect(r.stats).toMatchObject({ pages: 3, ocrPages: 1 });
      expect(r.status).toBe("partial"); // the blank page is still a gap
      expect(r.chunks.map((c) => c.locator.label)).toEqual(["p. 1", expect.stringMatching(/^p\. 2 \(OCR, \d{1,3}% confidence\)$/)]);
      expect(r.chunks[0]!.locator.ocr).toBeUndefined();
      expect(r.chunks[0]!.text).toContain("Decision requested");
      expect(r.chunks[1]!.locator).toMatchObject({ kind: "page", index: 2, ocr: { confidence: expect.any(Number) } });
      expect(words(r.chunks[1]!.text)).toContain("budget approved in march");
      expect(r.gaps).toContainEqual(expect.objectContaining({ code: "ocr_used", locator: expect.objectContaining({ index: 2 }), affectsCompleteness: false }));
      expect(r.gaps).toContainEqual(expect.objectContaining({ code: "no_text_layer", locator: expect.objectContaining({ index: 3 }), affectsCompleteness: true }));
    },
    OCR_TIMEOUT,
  );

  it("never starts OCR for a PDF whose pages all have a text layer", async () => {
    const { factory, calls } = fakeEngine(async () => ({ paragraphs: [] }));
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([["Revenue grew 12% in Q3 across all regions."], ["Churn fell to 3% after the pricing change."]]) }, { ocr: { engineFactory: factory } });
    expect(r.status).toBe("complete");
    expect(calls).toMatchObject({ created: 0, recognized: 0 });
    expect(r.chunks.every((c) => c.locator.ocr === undefined)).toBe(true);
  });

  it("stops at the OCR page limit and reports the remaining scanned pages", async () => {
    const { factory, calls } = fakeEngine(async () => ({ paragraphs: [[{ text: "Recognised line of text", confidence: 92 }]] }));
    const bytes = buildPdf([null, null, null]);
    const r = await extractSource({ kind: "pdf", bytes }, { ocr: { engineFactory: factory }, limits: { maxOcrPages: 2 } });
    expect(calls.recognized).toBe(2);
    expect(calls.terminated).toBe(1);
    expect(r.chunks.map((c) => c.locator.label)).toEqual(["p. 1 (OCR, 92% confidence)", "p. 2 (OCR, 92% confidence)"]);
    expect(r.status).toBe("partial");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "ocr_limit", locator: expect.objectContaining({ index: 3 }), affectsCompleteness: true }));
  });

  it("does not OCR a page too large to render at a readable resolution", async () => {
    const { factory, calls } = fakeEngine(async () => ({ paragraphs: [[{ text: "never", confidence: 99 }]] }));
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: factory }, limits: { maxOcrPixels: 500_000 } });
    expect(calls.recognized).toBe(0);
    expect(r.status).toBe("failed");
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "ocr_limit", message: "Page 1 is too large to render for OCR at a readable resolution." }));
  });

  it("leaves out low-confidence lines and reports them as a gap", async () => {
    const { factory } = fakeEngine(async () => ({
      paragraphs: [
        [
          { text: "Clear heading", confidence: 95 },
          { text: "~~ smudged ~~", confidence: 21 },
        ],
        [{ text: "Clear body", confidence: 85 }],
      ],
    }));
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: factory } });
    expect(r.chunks[0]!.text).toBe("Clear heading\n\nClear body");
    expect(r.chunks[0]!.locator.ocr!.confidence).toBe(91); // length-weighted mean of kept lines
    expect(r.status).toBe("partial");
    const gap = r.gaps.find((g) => g.code === "ocr_low_confidence")!;
    expect(gap).toMatchObject({ affectsCompleteness: true, locator: expect.objectContaining({ index: 1 }) });
    expect(gap.message).not.toContain("smudged");
  });

  it("turns an OCR timeout into a gap, terminates the engine and skips later pages", async () => {
    const { factory, calls } = fakeEngine(() => new Promise<OcrRecognition>(() => undefined));
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([null, null, ["Text layer page with enough characters."]]) }, { ocr: { engineFactory: factory }, limits: { ocrPageTimeoutMs: 50 } });
    expect(calls.recognized).toBe(1);
    expect(calls.terminated).toBe(1);
    expect(r.status).toBe("partial");
    expect(r.chunks.map((c) => c.locator.label)).toEqual(["p. 3"]);
    expect(r.gaps.filter((g) => g.code === "ocr_limit").map((g) => g.locator?.index)).toEqual([1, 2]);
    expect(r.gaps[0]!.message).toBe("Page 1 was not read by OCR: OCR exceeded its time limit.");
  });

  it("turns an engine failure into a gap instead of a crash", async () => {
    const factory: OcrEngineFactory = async () => {
      throw new Error("boom with /secret/path and source text");
    };
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: factory } });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("no_extractable_text");
    expect(r.gaps).toEqual([expect.objectContaining({ code: "ocr_failed", message: "Page 1 was not read by OCR: OCR could not process it." })]);
  });

  it("uses English by default and refuses invalid language codes or remote language data", async () => {
    const english = fakeEngine(async () => ({ paragraphs: [] }));
    await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: english.factory } });
    expect(english.calls.languages).toEqual(["eng"]);

    const bad = fakeEngine(async () => ({ paragraphs: [] }));
    const r1 = await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: bad.factory, languages: ["../etc/passwd"] } });
    expect(bad.calls.created).toBe(0);
    expect(r1.gaps).toContainEqual(expect.objectContaining({ code: "ocr_failed" }));

    const remote = fakeEngine(async () => ({ paragraphs: [] }));
    const r2 = await extractSource({ kind: "pdf", bytes: buildPdf([null]) }, { ocr: { engineFactory: remote.factory, langPath: "https://cdn.example/tessdata" } });
    expect(remote.calls.created).toBe(0);
    expect(r2.gaps).toContainEqual(expect.objectContaining({ code: "ocr_failed", message: expect.stringContaining("local directory") }));
  });

  it("reports scanned pages as gaps when OCR is turned off", async () => {
    const factory = vi.fn<OcrEngineFactory>();
    const r = await extractSource({ kind: "pdf", bytes: buildPdf([["Some text layer content here."], null]) }, { ocr: { enabled: false, engineFactory: factory } });
    expect(factory).not.toHaveBeenCalled();
    expect(r.gaps).toContainEqual(expect.objectContaining({ code: "no_text_layer", message: "Page 2 has no text layer; OCR is turned off." }));
  });
});
