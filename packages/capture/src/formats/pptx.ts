import JSZip from "jszip";
import type { Segment } from "../chunk";
import { locatorLabel } from "../chunk";
import type { CaptureLimits } from "../limits";
import type { ExtractionGap, Locator } from "../types";
import { decodeXmlEntities, normalizeText } from "../text";
import { OfficeOpenError, countMatches } from "./docx";

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

/** Shapes (`<p:sp>`) are never nested in themselves, so a lazy match is sufficient. */
const SHAPE = /<p:sp\b[\s\S]*?<\/p:sp>/g;
const TITLE_PLACEHOLDER = /<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/;
const BODY_PLACEHOLDER = /<p:ph\b[^>]*\btype="body"/;

/**
 * Extract text runs (`<a:t>`) grouped by paragraph (`<a:p>`), in document order.
 * `<a:br/>` becomes a line break. This is text extraction only: no layout, no chart
 * or SmartArt reconstruction.
 */
export function paragraphsFromXml(xml: string): string[] {
  const cleaned = xml.replace(/<a:p\s*\/>/g, "");
  const out: string[] = [];
  for (const p of cleaned.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) ?? []) {
    let text = "";
    for (const m of p.matchAll(/<a:t\s*\/>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) {
      if (m[0].startsWith("<a:br")) text += "\n";
      else if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
    }
    const t = text.replace(/[ \t]+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

function slideLocator(n: number, part?: "notes"): Locator {
  const loc: Locator = { kind: "slide", index: n, label: locatorLabel("slide", n, undefined, part) };
  if (part) loc.part = part;
  return loc;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Resolve the notes part for a slide from its relationships, falling back to the same number. */
async function notesPathFor(zip: JSZip, slideNo: number): Promise<string | null> {
  const rels = zip.file(`ppt/slides/_rels/slide${slideNo}.xml.rels`);
  if (rels) {
    const xml = await rels.async("string");
    for (const rel of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/Type="[^"]*\/notesSlide"/.test(rel)) continue;
      const target = /Target="([^"]+)"/.exec(rel)?.[1];
      if (!target) continue;
      const file = target.split("/").pop();
      if (file && /^notesSlide\d+\.xml$/.test(file)) return `ppt/notesSlides/${file}`;
    }
    return null;
  }
  const fallback = `ppt/notesSlides/notesSlide${slideNo}.xml`;
  return zip.file(fallback) ? fallback : null;
}

export interface PptxOptions {
  includeSpeakerNotes: boolean;
}

/**
 * Extract PPTX slide text from `ppt/slides/slideN.xml` in numeric order, with slide
 * titles as chunk headings, and optionally speaker notes as separate "notes" chunks.
 * Pictures, charts, diagrams and media are reported as gaps. The archive must already
 * have passed `checkZipSafety`; nothing is executed or fetched.
 */
export async function extractPptx(bytes: Uint8Array, limits: CaptureLimits, opts: PptxOptions): Promise<{ segments: Segment[]; gaps: ExtractionGap[]; slides: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new OfficeOpenError("corrupt_file", "The presentation archive could not be opened.");
  }

  const slideNumbers = Object.keys(zip.files)
    .map((name) => SLIDE_PATH.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  if (slideNumbers.length === 0) throw new OfficeOpenError("corrupt_file", "The presentation has no slides.");

  const segments: Segment[] = [];
  const gaps: ExtractionGap[] = [];
  const toRead = slideNumbers.slice(0, limits.maxSlides);
  let notesSkipped = 0;

  // Slides are numbered by their position in reading order (1..n), not by part name.
  for (const [i, partNo] of toRead.entries()) {
    const n = i + 1;
    const xml = await zip.file(`ppt/slides/slide${partNo}.xml`)!.async("string");
    if (xml.length > limits.maxEntryUncompressedBytes) throw new OfficeOpenError("limit_exceeded", "A slide is too large to process.");

    let title: string | undefined;
    for (const shape of xml.match(SHAPE) ?? []) {
      if (TITLE_PLACEHOLDER.test(shape)) {
        title = paragraphsFromXml(shape).join(" ").trim() || undefined;
        break;
      }
    }

    const paragraphs = paragraphsFromXml(xml);
    const text = normalizeText(paragraphs.join("\n\n"));
    const pictures = countMatches(xml, /<p:pic\b/g);
    const charts = countMatches(xml, /<c:chart\b/g);
    const diagrams = countMatches(xml, /drawingml\/2006\/diagram"/g);
    const media = countMatches(xml, /<a:(?:videoFile|audioFile)\b|<p14:media\b/g);

    if (text) {
      const seg: Segment = { text, group: `slide-${n}`, kind: "slide", index: n };
      if (title) seg.heading = title;
      segments.push(seg);
    } else if (pictures + charts + diagrams + media > 0) {
      gaps.push({ code: "image_only", message: `Slide ${n} contains no extractable text (possibly an image).`, locator: slideLocator(n), affectsCompleteness: true });
    } else {
      gaps.push({ code: "empty_section", message: `Slide ${n} contains no text.`, locator: slideLocator(n), affectsCompleteness: false });
    }
    if (text && pictures > 0) {
      gaps.push({ code: "image_not_extracted", message: `Slide ${n} contains ${plural(pictures, "image")}; image content is not extracted.`, locator: slideLocator(n), affectsCompleteness: true });
    }
    if (charts > 0) {
      gaps.push({ code: "chart_not_extracted", message: `Slide ${n} contains ${plural(charts, "chart")}; chart data is not extracted.`, locator: slideLocator(n), affectsCompleteness: true });
    }
    if (diagrams > 0) {
      gaps.push({ code: "diagram_not_extracted", message: `Slide ${n} contains ${plural(diagrams, "diagram")} (SmartArt); diagram text is not extracted.`, locator: slideLocator(n), affectsCompleteness: true });
    }
    if (media > 0) {
      gaps.push({ code: "media_not_extracted", message: `Slide ${n} contains audio or video, which is not extracted.`, locator: slideLocator(n), affectsCompleteness: true });
    }

    const notesPath = await notesPathFor(zip, partNo);
    const notesEntry = notesPath ? zip.file(notesPath) : null;
    if (notesEntry) {
      const notesXml = await notesEntry.async("string");
      // Only the notes body placeholder; skip the slide thumbnail and slide-number fields.
      const bodyShapes = (notesXml.match(SHAPE) ?? []).filter((s) => BODY_PLACEHOLDER.test(s));
      const notesText = normalizeText(bodyShapes.flatMap(paragraphsFromXml).join("\n\n"));
      if (notesText) {
        if (opts.includeSpeakerNotes) {
          const seg: Segment = { text: notesText, group: `slide-${n}-notes`, kind: "slide", index: n, part: "notes" };
          if (title) seg.heading = title;
          segments.push(seg);
        } else {
          notesSkipped += 1;
        }
      }
    }
  }

  if (notesSkipped > 0) {
    gaps.push({ code: "speaker_notes_excluded", message: `Speaker notes not included (${plural(notesSkipped, "slide")} with notes).`, affectsCompleteness: false });
  }
  if (slideNumbers.length > toRead.length) {
    gaps.push({ code: "truncated", message: `Only the first ${toRead.length} of ${slideNumbers.length} slides were extracted (slide limit).`, affectsCompleteness: true });
  }
  return { segments, gaps, slides: slideNumbers.length };
}
