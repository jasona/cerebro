import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { findRepoRoot } from "@cerebro/database";

/**
 * Private, immutable storage for original source bytes.
 *
 * Keys are content-addressed: `<organizationId>/<sha256>`. Objects are never
 * overwritten or served publicly; access is decided by the domain services
 * that hold the key (sources rows), never by the store.
 *
 * Only a local filesystem implementation exists. An S3-compatible adapter
 * (private bucket, server-side encryption, no public ACLs, `If-None-Match: *`
 * on put for immutability) is future work and must implement this interface.
 */
export interface SourceStore {
  put(organizationId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^([0-9a-f-]{36})\/([0-9a-f]{64})$/;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Local filesystem store under `<root>/<org>/<sha256>` (default `<repo>/.data/objects`, or `CEREBRO_OBJECTS_DIR`). */
export class LocalSourceStore implements SourceStore {
  readonly root: string;

  constructor(root?: string) {
    // turbopackIgnore: a runtime data directory, not a build input (avoids whole-project tracing).
    this.root = resolve(/*turbopackIgnore: true*/ root ?? process.env.CEREBRO_OBJECTS_DIR ?? join(findRepoRoot(), ".data", "objects"));
  }

  private pathFor(key: string): string {
    const m = KEY.exec(key);
    if (!m || !UUID.test(m[1]!)) throw new Error("invalid source object key");
    const path = resolve(this.root, m[1]!, m[2]!);
    if (!path.startsWith(this.root + sep)) throw new Error("invalid source object key");
    return path;
  }

  async put(organizationId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
    if (!UUID.test(organizationId)) throw new Error("invalid organization id");
    const sha256 = sha256Hex(bytes);
    const key = `${organizationId.toLowerCase()}/${sha256}`;
    const path = this.pathFor(key);
    await mkdir(resolve(this.root, organizationId.toLowerCase()), { recursive: true, mode: 0o700 });
    try {
      // `wx`: never overwrite. Same key means same content, so an existing object is fine.
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return { key, sha256 };
  }

  async get(key: string): Promise<Uint8Array> {
    const data = await readFile(this.pathFor(key));
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Integrity: the key is the content hash.
    if (sha256Hex(bytes) !== key.split("/")[1]) throw new Error("source object failed integrity check");
    return bytes;
  }
}

let store: SourceStore | undefined;

export function getSourceStore(): SourceStore {
  store ??= new LocalSourceStore();
  return store;
}

/** Configure the process-wide store (tests, or a future S3 adapter). */
export function setSourceStore(next: SourceStore | undefined): void {
  store = next;
}
