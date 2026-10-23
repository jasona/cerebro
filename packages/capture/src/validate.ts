import { isOleCompound, isPdf, looksLikeText, zipKind } from "./detect";
import { isImage, readImageHeader } from "./image";
import { resolveLimits, type CaptureLimits } from "./limits";
import type { ErrorCategory, SourceKind } from "./types";
import { checkZipSafety, isZip } from "./zip";

export type UploadErrorCode = Extract<
  ErrorCategory,
  | "invalid_input"
  | "empty"
  | "too_large"
  | "unsupported_format"
  | "legacy_or_encrypted_office"
  | "kind_mismatch"
  | "invalid_encoding"
  | "corrupt_file"
  | "unsafe_archive"
>;

export interface UploadError {
  code: UploadErrorCode;
  message: string;
  limit?: number;
  actual?: number;
}

export type UploadValidation = { ok: true; kind: SourceKind } | { ok: false; error: UploadError };

export interface ValidateUploadInput {
  kind: SourceKind;
  bytes?: Uint8Array;
  text?: string;
  filename?: string;
  mime?: string;
}

const TEXT_KINDS = new Set<SourceKind>(["text", "markdown", "conversation"]);
const fail = (error: UploadError): UploadValidation => ({ ok: false, error });

/**
 * Validate format, size, (for DOCX/PPTX) archive safety and (for images) declared
 * pixel dimensions before any parsing or decoding.
 * Synchronous and inflates nothing. Content is checked by magic bytes; the filename
 * and declared kind are never trusted on their own.
 */
export function validateUpload(input: ValidateUploadInput, overrides?: Partial<CaptureLimits>): UploadValidation {
  const limits = resolveLimits(overrides);
  const { kind, bytes, text } = input;

  if (TEXT_KINDS.has(kind)) {
    if (bytes === undefined && text === undefined) return fail({ code: "invalid_input", message: "No text or file was provided." });
    if (bytes !== undefined) {
      if (bytes.length > limits.maxBytes) return fail({ code: "too_large", message: "The file is larger than the upload limit.", limit: limits.maxBytes, actual: bytes.length });
      if (bytes.length > 0 && (isPdf(bytes) || isZip(bytes) || isImage(bytes) || isOleCompound(bytes) || !looksLikeText(bytes))) {
        return fail({ code: "kind_mismatch", message: `The file is not plain text and cannot be imported as ${kind}.` });
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (decoded.trim() === "" && (text ?? "").trim() === "") return fail({ code: "empty", message: "The source is empty." });
        if (decoded.length > limits.maxInputCharacters) return fail({ code: "too_large", message: "The text is longer than the import limit.", limit: limits.maxInputCharacters, actual: decoded.length });
      } catch {
        return fail({ code: "invalid_encoding", message: "The file is not valid UTF-8 text." });
      }
      return { ok: true, kind };
    }
    const t = text ?? "";
    if (t.trim() === "") return fail({ code: "empty", message: "The source is empty." });
    if (t.length > limits.maxInputCharacters) return fail({ code: "too_large", message: "The text is longer than the import limit.", limit: limits.maxInputCharacters, actual: t.length });
    return { ok: true, kind };
  }

  if (!bytes) return fail({ code: "invalid_input", message: `A ${kind.toUpperCase()} import requires file bytes.` });
  if (bytes.length === 0) return fail({ code: "empty", message: "The file is empty." });
  if (bytes.length > limits.maxBytes) return fail({ code: "too_large", message: "The file is larger than the upload limit.", limit: limits.maxBytes, actual: bytes.length });
  if (isOleCompound(bytes)) {
    return fail({ code: "legacy_or_encrypted_office", message: "This is a legacy (.doc/.ppt) or password-protected Office file. Save it as an unprotected .docx or .pptx and try again." });
  }

  if (kind === "image") {
    const header = readImageHeader(bytes);
    if (!header) {
      if (isPdf(bytes) || isZip(bytes) || looksLikeText(bytes)) return fail({ code: "kind_mismatch", message: "The file does not look like a PNG, JPEG or WebP image." });
      return fail({ code: "unsupported_format", message: "The file is not a supported image. Use PNG, JPEG or WebP." });
    }
    if (header.width === null || header.height === null) return fail({ code: "corrupt_file", message: "The image header is damaged." });
    // Decompression-bomb guard: refuse from the header, before any decoder allocates pixels.
    const pixels = header.width * header.height;
    if (pixels > limits.maxImagePixels || Math.max(header.width, header.height) > limits.maxImageDimension) {
      return fail({ code: "too_large", message: `The image is ${header.width}×${header.height} pixels, larger than the ${Math.round(limits.maxImagePixels / 1_000_000)}-megapixel or ${limits.maxImageDimension.toLocaleString("en-US")}-pixel-side limit for OCR.`, limit: limits.maxImagePixels, actual: pixels });
    }
    return { ok: true, kind };
  }

  if (kind === "pdf") {
    if (isPdf(bytes)) return { ok: true, kind };
    if (isZip(bytes) || isImage(bytes) || looksLikeText(bytes)) return fail({ code: "kind_mismatch", message: "The file does not look like a PDF." });
    return fail({ code: "unsupported_format", message: "The file is not a supported PDF." });
  }

  // docx / pptx
  if (!isZip(bytes)) {
    if (isPdf(bytes) || isImage(bytes) || looksLikeText(bytes)) return fail({ code: "kind_mismatch", message: `The file does not look like a ${kind.toUpperCase()} document.` });
    return fail({ code: "unsupported_format", message: `The file is not a supported ${kind.toUpperCase()} document.` });
  }
  const safety = checkZipSafety(bytes, limits);
  if ("problem" in safety) return fail({ code: safety.problem.code, message: safety.problem.message });
  const actual = zipKind(bytes);
  if (actual === null) return fail({ code: "unsupported_format", message: "The archive is not a Word or PowerPoint document." });
  if (actual !== kind) return fail({ code: "kind_mismatch", message: `The file is a ${actual.toUpperCase()} document, not ${kind.toUpperCase()}.` });
  return { ok: true, kind };
}
