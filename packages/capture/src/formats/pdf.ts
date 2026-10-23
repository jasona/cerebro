import { getDocumentProxy } from "unpdf";
import type { Segment } from "../chunk";
import type { CaptureLimits } from "../limits";
import type { ExtractionGap } from "../types";
import { normalizeText } from "../text";
import { locatorLabel } from "../chunk";

export class PdfOpenError extends Error {
  constructor(readonly category: "encrypted" | "corrupt_file") {
    super(category === "encrypted" ? "The PDF is password-protected." : "The PDF could not be read.");
  }
}

interface TextLike {
  str?: unknown;
  hasEOL?: unknown;
}

/**
 * Extract per-page text with page locators. Pages without a text layer are reported
 * as gaps (OCR is not supported). Uses the serverless pdf.js build bundled with unpdf;
 * scripting, fonts and rendering are not used.
 */
export async function extractPdf(bytes: Uint8Array, limits: CaptureLimits): Promise<{ segments: Segment[]; gaps: ExtractionGap[]; pages: number }> {
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may detach the buffer it is given, so pass a copy.
    doc = await getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: false, verbosity: 0 });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    throw new PdfOpenError(name === "PasswordException" ? "encrypted" : "corrupt_file");
  }

  const segments: Segment[] = [];
  const gaps: ExtractionGap[] = [];
  try {
    const pages = doc.numPages;
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
      if (!text) {
        gaps.push({ code: "no_text_layer", message: `Page ${n} has no text layer; OCR is not supported.`, locator: pageLocator(n), affectsCompleteness: true });
        continue;
      }
      segments.push({ text, group: `page-${n}`, kind: "page", index: n });
    }
    if (pages > readPages) {
      gaps.push({ code: "truncated", message: `Only the first ${readPages} of ${pages} pages were extracted (page limit).`, affectsCompleteness: true });
    }
    return { segments, gaps, pages };
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}

function pageLocator(n: number) {
  return { kind: "page" as const, index: n, label: locatorLabel("page", n) };
}
