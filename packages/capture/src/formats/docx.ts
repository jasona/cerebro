import JSZip from "jszip";
import mammoth from "mammoth";
import type { Segment } from "../chunk";
import type { CaptureLimits } from "../limits";
import type { ExtractionGap } from "../types";
import { normalizeText } from "../text";

export class OfficeOpenError extends Error {
  constructor(readonly category: "corrupt_file" | "limit_exceeded", message: string) {
    super(message);
  }
}

/**
 * Extract DOCX body text with mammoth's raw-text mode and split it into paragraphs.
 * Paragraph numbers count non-empty paragraphs in reading order; DOCX has no stable
 * page numbers, so locators are paragraphs. The archive must already have passed
 * `checkZipSafety`. Nothing in the document (macros, fields, external links) is executed
 * or fetched.
 */
export async function extractDocx(bytes: Uint8Array, limits: CaptureLimits): Promise<{ segments: Segment[]; gaps: ExtractionGap[]; paragraphs: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new OfficeOpenError("corrupt_file", "The document archive could not be opened.");
  }
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) throw new OfficeOpenError("corrupt_file", "The document has no main body part.");
  const documentXml = await docEntry.async("string");
  if (documentXml.length > limits.maxEntryUncompressedBytes) throw new OfficeOpenError("limit_exceeded", "The document body is too large.");

  let result: { value: string; messages: { type: string; message: string }[] };
  try {
    result = await mammoth.extractRawText({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  } catch {
    throw new OfficeOpenError("corrupt_file", "The document could not be read.");
  }

  const gaps: ExtractionGap[] = [];
  const seen = new Set<string>();
  for (const m of result.messages) {
    const key = `${m.type}:${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({ code: "converter_message", message: `DOCX ${m.type}: ${m.message}`.slice(0, 300), affectsCompleteness: true });
  }

  const images = countMatches(documentXml, /<pic:pic\b|<v:imagedata\b/g);
  if (images > 0) {
    gaps.push({ code: "image_not_extracted", message: `The document contains ${images} image${images === 1 ? "" : "s"}; image content is not extracted.`, affectsCompleteness: true });
  }
  const charts = countMatches(documentXml, /<c:chart\b|drawingml\/2006\/chart"/g);
  if (charts > 0) {
    gaps.push({ code: "chart_not_extracted", message: `The document contains ${charts} chart${charts === 1 ? "" : "s"}; chart data is not extracted.`, affectsCompleteness: true });
  }
  if (/<w:txbxContent\b/.test(documentXml)) {
    gaps.push({ code: "unrecognised_structure", message: "The document contains text boxes, which may be missing or out of order.", affectsCompleteness: true });
  }
  const hasHeaders = Object.keys(zip.files).some((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  if (hasHeaders) {
    gaps.push({ code: "unrecognised_structure", message: "Headers and footers are not included.", affectsCompleteness: false });
  }

  const paragraphs = normalizeText(result.value)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const segments: Segment[] = paragraphs.map((text, i) => ({ text, group: "body", kind: "paragraph", index: i + 1 }));
  return { segments, gaps, paragraphs: paragraphs.length };
}

export function countMatches(s: string, re: RegExp): number {
  return s.match(re)?.length ?? 0;
}
