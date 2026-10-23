import { createHash } from "node:crypto";

/**
 * Private, immutable storage for original source bytes.
 *
 * Keys are content-addressed: `<organizationId>/<sha256>`. Objects are never
 * overwritten or served publicly; access is decided by the domain services
 * that hold the key (sources rows), never by the store. `get` additionally
 * refuses a key outside the caller's organization (defense in depth) and
 * verifies the content hash.
 *
 * Implementations: `LocalSourceStore` (default) and `S3SourceStore`
 * (`s3-store.ts`), selected by `CEREBRO_OBJECT_STORE` (see `getSourceStore`).
 */
export interface SourceStore {
  put(organizationId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }>;
  get(organizationId: string, key: string): Promise<Uint8Array>;
  /**
   * Permanently remove an object (source deletion and retention). Deleting a
   * missing object succeeds. Keys are content-addressed per organization, so
   * callers delete a key only once no source row references it.
   */
  delete(organizationId: string, key: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^([0-9a-f-]{36})\/([0-9a-f]{64})$/;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export interface SourceObjectKey {
  key: string;
  organizationId: string;
  sha256: string;
}

/**
 * Validate a source object key. Shared by every store so key rules cannot
 * drift: exactly `<lowercase org uuid>/<lowercase sha256>`, nothing else (no
 * traversal, separators or prefixes). With `organizationId`, the key must
 * belong to that organization.
 */
export function parseSourceKey(key: string, organizationId?: string): SourceObjectKey {
  const m = KEY.exec(key);
  if (!m || !UUID.test(m[1]!) || key !== key.toLowerCase()) throw new Error("invalid source object key");
  if (organizationId !== undefined) {
    if (!UUID.test(organizationId)) throw new Error("invalid organization id");
    if (m[1] !== organizationId.toLowerCase()) throw new Error("source object key belongs to another organization");
  }
  return { key, organizationId: m[1]!, sha256: m[2]! };
}

/** Content-addressed key for `bytes` in `organizationId`. */
export function sourceKeyFor(organizationId: string, bytes: Uint8Array): SourceObjectKey {
  if (!UUID.test(organizationId)) throw new Error("invalid organization id");
  const sha256 = sha256Hex(bytes);
  return parseSourceKey(`${organizationId.toLowerCase()}/${sha256}`);
}

/** Integrity: the key is the content hash. */
export function verifySourceBytes(key: SourceObjectKey, bytes: Uint8Array): Uint8Array {
  if (sha256Hex(bytes) !== key.sha256) throw new Error("source object failed integrity check");
  return bytes;
}

