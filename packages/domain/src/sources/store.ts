import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { findRepoRoot } from "@cerebro/database";
import { parseSourceKey, sourceKeyFor, verifySourceBytes, type SourceObjectKey, type SourceStore } from "./object-key";
import { s3ConfigFromEnv, S3SourceStore } from "./s3-store";

export { parseSourceKey, sha256Hex, sourceKeyFor, verifySourceBytes, type SourceObjectKey, type SourceStore } from "./object-key";

/** Local filesystem store under `<root>/<org>/<sha256>` (default `<repo>/.data/objects`, or `CEREBRO_OBJECTS_DIR`). */
export class LocalSourceStore implements SourceStore {
  readonly root: string;

  constructor(root?: string) {
    // turbopackIgnore: a runtime data directory, not a build input (avoids whole-project tracing).
    this.root = resolve(/*turbopackIgnore: true*/ root ?? process.env.CEREBRO_OBJECTS_DIR ?? join(findRepoRoot(), ".data", "objects"));
  }

  private pathFor(key: SourceObjectKey): string {
    const path = resolve(this.root, key.organizationId, key.sha256);
    if (!path.startsWith(this.root + sep)) throw new Error("invalid source object key");
    return path;
  }

  async put(organizationId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
    const key = sourceKeyFor(organizationId, bytes);
    const path = this.pathFor(key);
    await mkdir(resolve(this.root, key.organizationId), { recursive: true, mode: 0o700 });
    try {
      // `wx`: never overwrite. Same key means same content, so an existing object is fine.
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return { key: key.key, sha256: key.sha256 };
  }

  async get(organizationId: string, key: string): Promise<Uint8Array> {
    const parsed = parseSourceKey(key, organizationId);
    const data = await readFile(this.pathFor(parsed));
    return verifySourceBytes(parsed, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  async delete(organizationId: string, key: string): Promise<void> {
    try {
      await unlink(this.pathFor(parseSourceKey(key, organizationId)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

let store: SourceStore | undefined;

/**
 * The process-wide store, created from the environment on first use
 * (`createSourceStoreFromEnv`). Throws if `CEREBRO_OBJECT_STORE` selects an
 * adapter that is not fully configured; call `assertSourceStoreConfig()` at
 * process start to fail fast instead.
 */
export function getSourceStore(): SourceStore {
  store ??= createSourceStoreFromEnv();
  return store;
}

/** Configure the process-wide store (tests). `undefined` resets to the environment default. */
export function setSourceStore(next: SourceStore | undefined): void {
  store = next;
}

export type ObjectStoreKind = "local" | "s3";

/** Which adapter the environment selects. Unset or empty means `local`; anything unknown is an error. */
export function objectStoreKind(env: NodeJS.ProcessEnv = process.env): ObjectStoreKind {
  const raw = env.CEREBRO_OBJECT_STORE?.trim().toLowerCase();
  if (!raw || raw === "local") return "local";
  if (raw === "s3") return "s3";
  throw new Error(`CEREBRO_OBJECT_STORE must be "local" or "s3".`);
}

/** Build a store from the environment. Validates configuration without network access. */
export function createSourceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SourceStore {
  if (objectStoreKind(env) === "s3") return new S3SourceStore(s3ConfigFromEnv(env));
  return new LocalSourceStore(env.CEREBRO_OBJECTS_DIR);
}

/** Fail fast at process start: throws a configuration error naming the missing or invalid variables. */
export function assertSourceStoreConfig(env: NodeJS.ProcessEnv = process.env): ObjectStoreKind {
  const kind = objectStoreKind(env);
  if (kind === "s3") s3ConfigFromEnv(env);
  return kind;
}
