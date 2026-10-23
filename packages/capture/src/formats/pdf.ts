import { createIsomorphicCanvasFactory, getDocumentProxy } from "unpdf";
import type { Segment } from "../chunk";
import type { CaptureLimits } from "../limits";
import { ocrUsedGap, plainLocator, type OcrSession } from "../ocr";
import type { ExtractionGap } from "../types";
import { normalizeText } from "../text";
import { loadCanvasModule } from "./image";

export class PdfOpenError extends Error {
  constructor(readonly category: "encrypted" | "corrupt_file") {
    super(category === "encrypted" ? "The PDF is password-protected." : "The PDF could not be read.");
  }
}

interface TextLike {
  str?: unknown;
  hasEOL?: unknown;
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

const nonSpaceLength = (s: string) => s.replace(/\s+/g, "").length;
const pageLocator = (n: number) => plainLocator("page", n);

/**
 * Extract per-page text with page locators. Uses the serverless pdf.js build
 * bundled with unpdf; scripting is not used.
 *
 * Pages with no or almost no text layer (fewer than `minTextLayerCharacters`
 * non-space characters) are scanned-page candidates: when OCR is enabled they
 * are rendered with @napi-rs/canvas and read by the local OCR engine, up to
 * `maxOcrPages` pages and within the session's time limits. OCR text replaces
 * the text layer only when it recovers more text. Everything OCR could not do
 * is reported as a gap with the page locator.
 */
export async function extractPdf(bytes: Uint8Array, limits: CaptureLimits, ocr: OcrSession): Promise<{ segments: Segment[]; gaps: ExtractionGap[]; pages: number; ocrPages: number }> {
  let doc: PdfDocument;
  try {
    // pdf.js may detach the buffer it is given, so pass a copy.
    doc = await getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: false, verbosity: 0 });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    throw new PdfOpenError(name === "PasswordException" ? "encrypted" : "corrupt_file");
  }

  const segments: Segment[] = [];
  const gaps: ExtractionGap[] = [];
  /** Pages whose text layer is missing or too thin, with whatever text it had. */
  const candidates: { n: number; text: string }[] = [];
  let pages: number;
  try {
    pages = doc.numPages;
    const readPages = Math.min(pages, limits.maxPages);
    for (let n = 1; n <= readPages; n++) {
      let raw = "";
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        for (const item of content.items as TextLike[]) {
          if (typeof item.str === "string") raw += item.str;
          if (item.hasEOL === true) raw += "\n";
        }
        page.cleanup();
      } catch {
        gaps.push({ code: "unrecognised_structure", message: `Page ${n} could not be read.`, locator: pageLocator(n), affectsCompleteness: true });
        continue;
      }
      const text = normalizeText(raw);
      if (ocr.enabled && nonSpaceLength(text) < limits.minTextLayerCharacters) {
        candidates.push({ n, text });
        continue;
      }
      if (!text) {
        gaps.push({ code: "no_text_layer", message: `Page ${n} has no text layer; OCR is turned off.`, locator: pageLocator(n), affectsCompleteness: true });
        continue;
      }
      segments.push({ text, group: `page-${n}`, kind: "page", index: n });
    }
    if (pages > readPages) {
      gaps.push({ code: "truncated", message: `Only the first ${readPages} of ${pages} pages were extracted (page limit).`, affectsCompleteness: true });
    }
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }

  const ocrPages = candidates.length ? await ocrCandidates(bytes, candidates, limits, ocr, segments, gaps) : 0;
  segments.sort((a, b) => a.index - b.index);
  return { segments, gaps, pages, ocrPages };
}

/** Keep the thin text layer of a candidate page, or report the page as a gap. */
function fallBack(c: { n: number; text: string }, segments: Segment[], gaps: ExtractionGap[], gap?: ExtractionGap) {
  if (gap) gaps.push(gap);
  if (c.text) segments.push({ text: c.text, group: `page-${c.n}`, kind: "page", index: c.n });
  else if (!gap) gaps.push({ code: "no_text_layer", message: `Page ${c.n} has no text layer, and OCR found no readable text.`, locator: pageLocator(c.n), affectsCompleteness: true });
}

async function ocrCandidates(
  bytes: Uint8Array,
  candidates: { n: number; text: string }[],
  limits: CaptureLimits,
  ocr: OcrSession,
  segments: Segment[],
  gaps: ExtractionGap[],
): Promise<number> {
  let doc: PdfDocument | null = null;
  let canvasModule: Awaited<ReturnType<typeof loadCanvasModule>>;
  try {
    canvasModule = await loadCanvasModule();
    const CanvasFactory = await createIsomorphicCanvasFactory(async () => canvasModule);
    // A separate document for rendering: text-only PDFs never load the canvas.
    // maxImageSize stops pdf.js decoding embedded images larger than the pixel limit.
    doc = await getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: false, verbosity: 0, CanvasFactory, maxImageSize: limits.maxImagePixels });
  } catch {
    for (const c of candidates) {
      fallBack(c, segments, gaps, c.text ? undefined : { code: "ocr_failed", message: `Page ${c.n} has no text layer and could not be rendered for OCR.`, locator: pageLocator(c.n), affectsCompleteness: true });
    }
    return 0;
  }

  let read = 0;
  try {
    for (const [i, c] of candidates.entries()) {
      const loc = pageLocator(c.n);
      if (i >= limits.maxOcrPages) {
        fallBack(c, segments, gaps, { code: "ocr_limit", message: `Page ${c.n} has no text layer and was not read by OCR (limit of ${limits.maxOcrPages} OCR pages per source).`, locator: loc, affectsCompleteness: true });
        continue;
      }
      let png: Uint8Array;
      try {
        const page = await doc.getPage(c.n);
        const base = page.getViewport({ scale: 1 }); // 72 dpi
        const dpi = Math.min(limits.ocrRenderDpi, 72 * Math.sqrt(limits.maxOcrPixels / Math.max(1, base.width * base.height)));
        if (dpi < limits.minOcrRenderDpi) {
          page.cleanup();
          fallBack(c, segments, gaps, { code: "ocr_limit", message: `Page ${c.n} is too large to render for OCR at a readable resolution.`, locator: loc, affectsCompleteness: true });
          continue;
        }
        const viewport = page.getViewport({ scale: dpi / 72 });
        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        const canvas = canvasModule.createCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
        png = await canvas.encode("png");
        page.cleanup();
      } catch {
        fallBack(c, segments, gaps, { code: "ocr_failed", message: `Page ${c.n} could not be rendered for OCR.`, locator: loc, affectsCompleteness: true });
        continue;
      }

      const result = await ocr.read(png, loc);
      if (!result.ok) {
        fallBack(c, segments, gaps, result.gap);
        continue;
      }
      const text = normalizeText(result.text);
      gaps.push(...result.gaps);
      if (nonSpaceLength(text) > nonSpaceLength(c.text)) {
        segments.push({ text, group: `page-${c.n}`, kind: "page", index: c.n, ocrConfidence: result.confidence });
        gaps.push(ocrUsedGap(loc, result.confidence));
        read += 1;
      } else {
        fallBack(c, segments, gaps);
      }
    }
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
  return read;
}
