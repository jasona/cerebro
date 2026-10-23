import type { SourceKind } from "./types";
import { isZip, readZipDirectory } from "./zip";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isPdf(bytes: Uint8Array): boolean {
  // The PDF header must appear within the first 1024 bytes.
  const end = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

/** Legacy binary Office (.doc/.ppt) or password-protected OOXML, both stored as OLE compound files. */
export function isOleCompound(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && OLE_MAGIC.every((b, i) => bytes[i] === b);
}

/** Heuristic: no NUL bytes in the first 8 KiB and valid UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    // stream: true tolerates a multi-byte sequence split at the 8 KiB boundary.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytes.length > head.length });
    return true;
  } catch {
    return false;
  }
}

export function zipKind(bytes: Uint8Array): "docx" | "pptx" | null {
  const dir = readZipDirectory(bytes);
  if ("problem" in dir) return null;
  const names = dir.entries.map((e) => e.name);
  if (names.includes("word/document.xml")) return "docx";
  if (names.includes("ppt/presentation.xml") || names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return "pptx";
  return null;
}

function extensionOf(filename?: string): string {
  if (!filename) return "";
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

function kindFromHints(filename?: string, mime?: string): SourceKind | null {
  const ext = extensionOf(filename);
  const type = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (ext === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (ext === "pptx" || type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (ext === "md" || ext === "markdown" || type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (ext === "txt" || ext === "text" || type === "text/plain") return "text";
  return null;
}

/**
 * Detect the source kind. Magic bytes win over filename and MIME type: `%PDF`,
 * or a ZIP whose directory contains `word/document.xml` (DOCX) or `ppt/` parts (PPTX).
 * Text is recognised only when the bytes are valid UTF-8 without NULs.
 * Returns null for unsupported or unrecognisable content (including legacy
 * .doc/.ppt and other ZIP formats such as XLSX). Never returns "conversation":
 * a pasted transcript is a caller choice, not a file type.
 */
export function detectKind(filename?: string, mime?: string, bytes?: Uint8Array): SourceKind | null {
  const hinted = kindFromHints(filename, mime);
  if (!bytes) return hinted;
  if (bytes.length === 0) return hinted === "text" || hinted === "markdown" ? hinted : null;
  if (isPdf(bytes)) return "pdf";
  if (isZip(bytes)) return zipKind(bytes);
  if (isOleCompound(bytes)) return null;
  if (looksLikeText(bytes)) {
    if (hinted === "markdown") return "markdown";
    if (hinted === null || hinted === "text") return "text";
    return null; // claimed PDF/DOCX/PPTX but the bytes are plain text
  }
  return null;
}
