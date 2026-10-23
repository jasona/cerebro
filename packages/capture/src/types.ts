/**
 * Public types for `@cerebro/capture`.
 *
 * SECURITY: everything produced by this package is extracted from author-supplied
 * files and pastes. It is untrusted data. Text that looks like instructions
 * ("ignore previous instructions", "publish this to everyone", tool-call syntax, …)
 * is carried through verbatim as content and must never be interpreted as a command,
 * used to change permissions, or allowed to invoke application tools.
 */

import type { CaptureLimits } from "./limits";

export type SourceKind = "text" | "markdown" | "pdf" | "docx" | "pptx" | "image" | "conversation";

export const SOURCE_KINDS = ["text", "markdown", "pdf", "docx", "pptx", "image", "conversation"] as const satisfies readonly SourceKind[];

export interface ExtractSourceInput {
  kind: SourceKind;
  /** Raw file bytes. Required for pdf/docx/pptx/image; optional for text kinds (UTF-8). */
  bytes?: Uint8Array;
  /** Pasted text. Used for text, markdown and conversation kinds. */
  text?: string;
  /** Original filename; used only for type checks, never trusted over magic bytes. */
  filename?: string;
}

export type LocatorKind = "page" | "slide" | "paragraph" | "message" | "line" | "image";

export type MessageRole = "user" | "assistant" | "system";

export interface Locator {
  kind: LocatorKind;
  /** 1-based page, slide, paragraph, message or line number of the chunk's start (1 for a single image). */
  index: number;
  /** Inclusive end, when the chunk spans several paragraphs or lines. */
  endIndex?: number;
  /**
   * Human label such as "p. 8", "Slide 3", "Slide 3 notes", "Message 4", "Paragraphs 2–5", "Lines 10–14".
   * OCR-derived text says so: "p. 3 (OCR, 91% confidence)", "Image (OCR, 88% confidence)".
   */
  label: string;
  /** "notes" for PPTX speaker notes. Absent for main content. */
  part?: "notes";
  /** Conversation messages only. */
  role?: MessageRole;
  /** Conversation messages only: speaker as written, e.g. "ChatGPT", "You". */
  speaker?: string;
  /**
   * Present when the text was machine-read by OCR (a scanned page or an image),
   * not taken from a text layer. `confidence` is the recogniser's mean confidence
   * (0–100) for the kept lines; it is not a measure of correctness.
   */
  ocr?: { confidence: number };
}

export interface Chunk {
  /** 0-based position of the chunk within the source. */
  ordinal: number;
  text: string;
  locator: Locator;
  /** Section heading (Markdown heading or slide title) the chunk belongs to, when known. */
  heading?: string;
  /** "sha256:<hex>" of `text` (UTF-8). */
  checksum: string;
}

export type GapCode =
  | "no_text_layer" // PDF page without text that OCR did not recover
  | "image_only" // slide/page appears to contain only images
  | "image_not_extracted" // images present alongside text
  | "chart_not_extracted"
  | "diagram_not_extracted"
  | "media_not_extracted"
  | "speaker_notes_excluded"
  | "empty_section" // e.g. a blank slide
  | "converter_message" // DOCX converter warning/error
  | "truncated" // a page/slide/character limit was reached
  | "unrecognised_structure" // e.g. no speaker markers in a conversation
  | "ocr_used" // informational: text on this page/image was machine-read
  | "ocr_low_confidence" // OCR lines below the confidence threshold were left out
  | "ocr_failed" // OCR errored or timed out
  | "ocr_limit"; // an OCR page, pixel or time limit was reached

export interface ExtractionGap {
  code: GapCode;
  /** Author-facing explanation, e.g. "Page 3 was read by OCR". Never contains extracted text. */
  message: string;
  locator?: Locator;
  /**
   * True when content from the source may be missing from `chunks`. Any such gap makes
   * the result "partial". Informational gaps (a blank slide, notes deliberately
   * excluded by the caller) do not.
   */
  affectsCompleteness: boolean;
}

export type ErrorCategory =
  | "invalid_input"
  | "empty"
  | "too_large"
  | "unsupported_format"
  | "legacy_or_encrypted_office"
  | "kind_mismatch"
  | "invalid_encoding"
  | "corrupt_file"
  | "encrypted"
  | "unsafe_archive"
  | "limit_exceeded"
  | "no_extractable_text"
  | "extraction_error";

export interface ExtractionStats {
  pages?: number;
  slides?: number;
  messages?: number;
  paragraphs?: number;
  /** Pages (or images) whose text came from OCR. */
  ocrPages?: number;
  /** Characters of extracted text (after normalisation, before chunk joining). */
  characters: number;
}

export interface ExtractionResult {
  status: "complete" | "partial" | "failed";
  chunks: Chunk[];
  gaps: ExtractionGap[];
  stats: ExtractionStats;
  /** Present when status is "failed". */
  errorCategory?: ErrorCategory;
  /** Author-facing message for a failure. Never contains extracted text. */
  errorMessage?: string;
}

export interface ExtractOptions {
  /** PPTX: include speaker notes as separate "notes" chunks. Default true. */
  includeSpeakerNotes?: boolean;
  /** Override individual limits (mainly for tests and stricter callers). */
  limits?: Partial<CaptureLimits>;
  /** OCR for scanned PDF pages and images. Enabled by default, English only. */
  ocr?: OcrOptions;
}

/** One recognised line with the recogniser's confidence (0–100). */
export interface OcrLine {
  text: string;
  confidence: number;
}

/** Recognised text for one image: paragraphs of lines, in reading order. */
export interface OcrRecognition {
  paragraphs: OcrLine[][];
}

/** A local OCR engine. `recognize` takes an encoded PNG. */
export interface OcrEngine {
  recognize(png: Uint8Array): Promise<OcrRecognition>;
  terminate(): Promise<void>;
}

export type OcrEngineFactory = (config: { languages: readonly string[]; langPath?: string }) => Promise<OcrEngine>;

export interface OcrOptions {
  /** Default true. When false, pages without a text layer and images are reported as gaps. */
  enabled?: boolean;
  /**
   * Tesseract language codes. Default `["eng"]`, the only language data bundled
   * (`@tesseract.js-data/eng`). Other languages need their own traineddata in `langPath`.
   */
  languages?: readonly string[];
  /** Local directory holding `<lang>.traineddata.gz`. Default: the bundled English data. Never a URL. */
  langPath?: string;
  /** Replace the engine (tests, or hosts supplying another local engine). Default: tesseract.js. */
  engineFactory?: OcrEngineFactory;
}
