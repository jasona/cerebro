import { createHash } from "node:crypto";

/**
 * Normalise extracted text: NFC, LF line endings, no control characters other than
 * tab/newline, no trailing spaces, at most two consecutive blank lines.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/^﻿/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[ent] ?? m;
  });
}

export function checksum(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}
