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

export type SourceKind = "text" | "markdown" | "pdf" | "docx" | "pptx" | "conversation";

export const SOURCE_KINDS = ["text", "markdown", "pdf", "docx", "pptx", "conversation"] as const satisfies readonly SourceKind[];

export interface ExtractSourceInput {
  kind: SourceKind;
  /** Raw file bytes. Required for pdf/docx/pptx; optional for text kinds (UTF-8). */
  bytes?: Uint8Array;
  /** Pasted text. Used for text, markdown and conversation kinds. */
  text?: string;
  /** Original filename; used only for type checks, never trusted over magic bytes. */
  filename?: string;
}

export type LocatorKind = "page" | "slide" | "paragraph" | "message" | "line";

export type MessageRole = "user" | "assistant" | "system";

export interface Locator {
  kind: LocatorKind;
  /** 1-based page, slide, paragraph, message or line number of the chunk's start. */
  index: number;
  /** Inclusive end, when the chunk spans several paragraphs or lines. */
  endIndex?: number;
  /** Human label such as "p. 8", "Slide 3", "Slide 3 notes", "Message 4", "Paragraphs 2–5", "Lines 10–14". */
  label: string;
  /** "notes" for PPTX speaker notes. Absent for main content. */
  part?: "notes";
  /** Conversation messages only. */
  role?: MessageRole;
  /** Conversation messages only: speaker as written, e.g. "ChatGPT", "You". */
  speaker?: string;
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
  | "no_text_layer" // PDF page without text; OCR not supported
  | "image_only" // slide/page appears to contain only images
  | "image_not_extracted" // images present alongside text
  | "chart_not_extracted"
  | "diagram_not_extracted"
  | "media_not_extracted"
  | "speaker_notes_excluded"
  | "empty_section" // e.g. a blank slide
  | "converter_message" // DOCX converter warning/error
  | "truncated" // a page/slide/character limit was reached
  | "unrecognised_structure"; // e.g. no speaker markers in a conversation

export interface ExtractionGap {
  code: GapCode;
  /** Author-facing explanation, e.g. "Page 3 has no text layer; OCR is not supported". Never contains extracted text. */
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
}
