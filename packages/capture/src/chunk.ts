import type { Chunk, Locator, LocatorKind, MessageRole } from "./types";
import { checksum } from "./text";

/**
 * A located piece of source text. Consecutive segments with the same `group` may be
 * packed into one chunk (e.g. DOCX paragraphs, Markdown paragraphs under a heading);
 * chunks never cross a group boundary (a page, slide, message or section).
 */
export interface Segment {
  text: string;
  group: string;
  kind: LocatorKind;
  index: number;
  endIndex?: number;
  part?: "notes";
  role?: MessageRole;
  speaker?: string;
  heading?: string;
  /** Set when the text was machine-read by OCR: the recogniser's mean confidence (0–100). */
  ocrConfidence?: number;
}

export interface ChunkingOptions {
  targetCharacters: number;
  maxCharacters: number;
}

interface Unit {
  text: string;
  /** Separator placed before this unit when it follows another unit in the same chunk. */
  joiner: string;
  seg: Segment;
}

const SENTENCE_BOUNDARY = /(?<=[.!?…]["'”’)\]]?)\s+(?=\S)/u;

/** Split at whitespace near `target`, never inside a surrogate pair. */
function hardSplit(text: string, target: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > target) {
    let cut = rest.lastIndexOf(" ", target);
    const nl = rest.lastIndexOf("\n", target);
    cut = Math.max(cut, nl);
    if (cut < target / 2) {
      cut = target;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Break one segment's text into units no longer than `max`, preferring paragraph, then sentence, then line boundaries. */
function atomize(seg: Segment, opts: ChunkingOptions): Unit[] {
  const units: Unit[] = [];
  const paragraphs = seg.text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    if (para.length <= opts.maxCharacters) {
      units.push({ text: para, joiner: "\n\n", seg });
      continue;
    }
    let first = true;
    for (const sentence of para.split(SENTENCE_BOUNDARY)) {
      const s = sentence.trim();
      if (!s) continue;
      const pieces = s.length <= opts.maxCharacters ? [s] : s.split("\n").flatMap((line) => (line.length <= opts.maxCharacters ? [line.trim()] : hardSplit(line, opts.targetCharacters)));
      for (const piece of pieces) {
        if (!piece) continue;
        units.push({ text: piece, joiner: first ? "\n\n" : " ", seg });
        first = false;
      }
    }
  }
  return units;
}

export function locatorLabel(kind: LocatorKind, index: number, endIndex?: number, part?: "notes"): string {
  const range = endIndex !== undefined && endIndex !== index;
  switch (kind) {
    case "page":
      return range ? `pp. ${index}–${endIndex}` : `p. ${index}`;
    case "slide":
      return `Slide ${index}${part === "notes" ? " notes" : ""}`;
    case "paragraph":
      return range ? `Paragraphs ${index}–${endIndex}` : `Paragraph ${index}`;
    case "message":
      return `Message ${index}`;
    case "line":
      return range ? `Lines ${index}–${endIndex}` : `Line ${index}`;
    case "image":
      return "Image";
  }
}

/** Label suffix for OCR-derived text, so authors see it was machine-read. */
export function ocrLabel(label: string, confidence: number): string {
  return `${label} (OCR, ${confidence}% confidence)`;
}

function buildLocator(first: Segment, last: Segment): Locator {
  const end = last.endIndex ?? last.index;
  const endIndex = end !== first.index ? end : undefined;
  const locator: Locator = { kind: first.kind, index: first.index, label: locatorLabel(first.kind, first.index, endIndex, first.part) };
  if (endIndex !== undefined) locator.endIndex = endIndex;
  if (first.part) locator.part = first.part;
  if (first.role) locator.role = first.role;
  if (first.speaker) locator.speaker = first.speaker;
  if (first.ocrConfidence !== undefined) {
    locator.ocr = { confidence: first.ocrConfidence };
    locator.label = ocrLabel(locator.label, first.ocrConfidence);
  }
  return locator;
}

/**
 * Pack segments into chunks of roughly `targetCharacters` (never more than
 * `maxCharacters` unless a single unbreakable token is longer), splitting on
 * paragraph and sentence boundaries and keeping each chunk's locator.
 */
export function chunkSegments(segments: Segment[], opts: ChunkingOptions, startOrdinal = 0): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Unit[] = [];
  let length = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((u, i) => (i === 0 ? u.text : u.joiner + u.text)).join("");
    const first = current[0]!.seg;
    const last = current[current.length - 1]!.seg;
    const chunk: Chunk = { ordinal: startOrdinal + chunks.length, text, locator: buildLocator(first, last), checksum: checksum(text) };
    if (first.heading) chunk.heading = first.heading;
    chunks.push(chunk);
    current = [];
    length = 0;
  };

  for (const seg of segments) {
    if (current.length > 0 && current[0]!.seg.group !== seg.group) flush();
    const units = atomize(seg, opts);
    units.forEach((unit, i) => {
      // Units from a different segment always join as a new paragraph.
      const joiner = i === 0 ? "\n\n" : unit.joiner;
      const u = { ...unit, joiner };
      if (current.length > 0 && length + joiner.length + u.text.length > opts.targetCharacters) flush();
      length += (current.length > 0 ? joiner.length : 0) + u.text.length;
      current.push(u);
    });
  }
  flush();
  return chunks;
}

/** Convenience: chunk a single block of text with one locator. */
export function chunkText(text: string, locator: Omit<Segment, "text" | "group">, opts: ChunkingOptions): Chunk[] {
  return chunkSegments([{ ...locator, text, group: "all" }], opts);
}
