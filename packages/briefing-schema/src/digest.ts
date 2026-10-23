import { createHash } from "node:crypto";
import { canonicalJson } from "./publish";

/**
 * SHA-256 hex digest of the canonical JSON form (sorted keys) of `doc`.
 * Stable across key order. The domain layer binds publication previews to it.
 *
 * Digest the *parsed* document: schema defaults (e.g. `evidenceRefs: []`)
 * change the canonical form, so raw input and its parsed form differ.
 *
 * Server-only (uses `node:crypto`); `@cerebro/briefing-schema/client` omits it.
 */
export function documentDigest(doc: unknown): string {
  return createHash("sha256").update(canonicalJson(doc), "utf8").digest("hex");
}
