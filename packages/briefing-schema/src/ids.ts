/**
 * Document-internal identifiers. Database rows use UUIDs; ids inside the
 * canonical document are short prefixed strings that stay stable across edits
 * to the same conceptual element.
 */
export const ID_PREFIXES = ["blk", "sec", "ev", "psp", "itm"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Generates ids for a document. Composers accept one so tests can be deterministic. */
export type IdFactory = (prefix: IdPrefix) => string;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 12;
// Largest multiple of 62 that fits in a byte; bytes at or above it are rejected
// so every character is uniformly distributed.
const REJECT_AT = 248;

/**
 * `newId("blk")` → `"blk_3fK9aZq0LmT2"`: 12 base62 characters from the Web
 * Crypto CSPRNG (available in Node ≥ 19 and browsers).
 */
export function newId(prefix: IdPrefix): string {
  let out = "";
  const buf = new Uint8Array(ID_LENGTH * 2);
  while (out.length < ID_LENGTH) {
    globalThis.crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= REJECT_AT) continue;
      out += ALPHABET[byte % 62];
      if (out.length === ID_LENGTH) break;
    }
  }
  return `${prefix}_${out}`;
}

/** Deterministic factory for tests and fixtures: `blk_0001`, `sec_0002`, … */
export function sequentialIds(start = 1): IdFactory {
  let n = start;
  return (prefix) => `${prefix}_${String(n++).padStart(4, "0")}`;
}
