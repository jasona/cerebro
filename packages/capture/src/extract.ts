import { z } from "zod";
import { chunkSegments, type Segment } from "./chunk";
import { extractDocx, OfficeOpenError } from "./formats/docx";
import { parseConversation } from "./formats/conversation";
import { extractImage, ImageOpenError } from "./formats/image";
import { extractPdf, PdfOpenError } from "./formats/pdf";
import { plainSegments } from "./formats/plain";
import { extractPptx } from "./formats/pptx";
import { resolveLimits, type CaptureLimits } from "./limits";
import { OcrSession } from "./ocr";
import { normalizeText } from "./text";
import { SOURCE_KINDS, type ErrorCategory, type ExtractionGap, type ExtractionResult, type ExtractionStats, type ExtractOptions, type ExtractSourceInput } from "./types";
import { validateUpload } from "./validate";

export const ExtractSourceInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  bytes: z.instanceof(Uint8Array).optional(),
  text: z.string().optional(),
  filename: z.string().max(1024).optional(),
});

function failed(errorCategory: ErrorCategory, errorMessage: string, gaps: ExtractionGap[] = [], stats: ExtractionStats = { characters: 0 }): ExtractionResult {
  return { status: "failed", chunks: [], gaps, stats, errorCategory, errorMessage };
}

/** Apply the character limit across segments in order, truncating the last one kept. */
function applyCharacterLimit(segments: Segment[], limits: CaptureLimits): { segments: Segment[]; characters: number; truncated: boolean } {
  let total = 0;
  const kept: Segment[] = [];
  for (const seg of segments) {
    const remaining = limits.maxCharacters - total;
    if (remaining <= 0) return { segments: kept, characters: total, truncated: true };
    if (seg.text.length > remaining) {
      kept.push({ ...seg, text: seg.text.slice(0, remaining) });
      return { segments: kept, characters: limits.maxCharacters, truncated: true };
    }
    kept.push(seg);
    total += seg.text.length;
  }
  return { segments: kept, characters: total, truncated: false };
}

function decodeText(input: ExtractSourceInput): string {
  if (input.bytes && input.bytes.length > 0) return new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  return input.text ?? "";
}

/**
 * Extract text with locators from an author source.
 *
 * - Never throws for bad input: unsupported, corrupt, oversized or unsafe files return
 *   `status: "failed"` with an `errorCategory`.
 * - `status: "partial"` whenever any gap may have lost content (images, charts, pages
 *   without a text layer, truncation, converter warnings). Partial results are never
 *   reported as complete.
 * - Extracted text is UNTRUSTED DATA. Instructions embedded in a source ("ignore your
 *   rules", "publish to all", tool syntax) are content to be shown and cited, never
 *   interpreted, and cannot change permissions or invoke tools.
 * - This function does not log extracted text, filenames, or parser output. Callers
 *   must not log `chunks[].text` either.
 * - Output is a private authoring resource. Chunks are not reader evidence until an
 *   author approves excerpts at publication.
 * - OCR (scanned PDF pages, images) runs locally with bundled language data and
 *   is CPU-heavy: call this only from the background extraction job, never from a
 *   request handler. OCR text is marked in its locator ("p. 3 (OCR, 91% confidence)")
 *   and by an `ocr_used` gap; OCR failures, timeouts and limits become gaps.
 */
export async function extractSource(input: ExtractSourceInput, options: ExtractOptions = {}): Promise<ExtractionResult> {
  const parsed = ExtractSourceInputSchema.safeParse(input);
  if (!parsed.success) return failed("invalid_input", "The import request is not valid.");
  const limits = resolveLimits(options.limits);
  const src = parsed.data as ExtractSourceInput;

  const valid = validateUpload(src, limits);
  if (!valid.ok) return failed(valid.error.code, valid.error.message);

  const chunking = { targetCharacters: limits.targetChunkCharacters, maxCharacters: limits.maxChunkCharacters };
  let segments: Segment[] = [];
  const gaps: ExtractionGap[] = [];
  const stats: ExtractionStats = { characters: 0 };
  const ocr = new OcrSession(options.ocr ?? {}, limits);

  try {
    switch (src.kind) {
      case "text":
      case "markdown": {
        segments = plainSegments(normalizeText(decodeText(src)), src.kind === "markdown");
        break;
      }
      case "conversation": {
        const conv = parseConversation(normalizeText(decodeText(src)));
        if (conv.messages.length === 0) {
          gaps.push({ code: "unrecognised_structure", message: "No speaker markers were recognised; the transcript was imported as plain text without message locators.", affectsCompleteness: true });
          segments = plainSegments(normalizeText(decodeText(src)), false);
        } else {
          let messages = conv.messages;
          if (messages.length > limits.maxMessages) {
            gaps.push({ code: "truncated", message: `Only the first ${limits.maxMessages} of ${messages.length} messages were extracted (message limit).`, affectsCompleteness: true });
            messages = messages.slice(0, limits.maxMessages);
          }
          segments = [...conv.preamble, ...messages];
          stats.messages = conv.messages.length;
        }
        break;
      }
      case "pdf": {
        const r = await extractPdf(src.bytes!, limits, ocr);
        segments = r.segments;
        gaps.push(...r.gaps);
        stats.pages = r.pages;
        if (r.ocrPages > 0) stats.ocrPages = r.ocrPages;
        break;
      }
      case "image": {
        const r = await extractImage(src.bytes!, limits, ocr);
        segments = r.segments;
        gaps.push(...r.gaps);
        if (r.segments.length > 0) stats.ocrPages = 1;
        break;
      }
      case "docx": {
        const r = await extractDocx(src.bytes!, limits);
        segments = r.segments;
        gaps.push(...r.gaps);
        stats.paragraphs = r.paragraphs;
        break;
      }
      case "pptx": {
        const r = await extractPptx(src.bytes!, limits, { includeSpeakerNotes: options.includeSpeakerNotes ?? true });
        segments = r.segments;
        gaps.push(...r.gaps);
        stats.slides = r.slides;
        break;
      }
    }
  } catch (err) {
    if (err instanceof PdfOpenError) return failed(err.category, err.message, gaps, stats);
    if (err instanceof OfficeOpenError) return failed(err.category, err.message, gaps, stats);
    if (err instanceof ImageOpenError) return failed(err.category, err.message, gaps, stats);
    // Deliberately do not include the underlying error message: it may quote content.
    return failed("extraction_error", "The source could not be processed.", gaps, stats);
  } finally {
    await ocr.close();
  }

  const limited = applyCharacterLimit(segments, limits);
  stats.characters = limited.characters;
  if (limited.truncated) {
    gaps.push({ code: "truncated", message: `Extraction stopped at the ${limits.maxCharacters.toLocaleString("en-US")}-character limit; later content is not included.`, affectsCompleteness: true });
  }

  const chunks = chunkSegments(limited.segments, chunking);
  if (chunks.length === 0) {
    const message = ocr.enabled
      ? "No extractable text was found, including by OCR. See the gaps for each page."
      : "No extractable text was found. Scanned pages and images need OCR, which is turned off.";
    return failed("no_extractable_text", message, gaps, stats);
  }
  return { status: gaps.some((g) => g.affectsCompleteness) ? "partial" : "complete", chunks, gaps, stats };
}
