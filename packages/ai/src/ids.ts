import { fnv1a } from "./text";

export type IdPrefix = "blk" | "sec" | "ev" | "psp" | "itm";
export type IdFactory = (prefix: IdPrefix) => string;

/**
 * Deterministic id factory: same seed, same ids. The deterministic provider
 * seeds it from its input so repeated runs produce identical proposals.
 * `taken` ids are skipped so additions never collide with existing ones.
 */
export function seededIds(seedText: string, taken: Iterable<string> = []): IdFactory {
  const seed = fnv1a(seedText).padStart(4, "0");
  const used = new Set(taken);
  let n = 1;
  return (prefix) => {
    for (;;) {
      const id = `${prefix}_${seed}${String(n++).padStart(4, "0")}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/** All prefixed ids present in a document-like value. */
export function collectIds(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^(blk|sec|ev|psp|itm)_/.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectIds(v, out);
  }
  return out;
}
