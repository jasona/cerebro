import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { BackupObjectStore } from "@cerebro/database/backup";
import { parseSourceKey } from "./object-key";
import { s3ConfigFromEnv, S3SourceStore } from "./s3-store";
import { objectStoreKind } from "./store";

/**
 * The S3 source store as a backup source and restore target (D26):
 * `db:backup` streams every object under the store's prefix into
 * `<backup>/objects/<org>/<sha256>`, verifying the sha256 while writing, and
 * `db:restore` writes them back with the store's immutable put.
 *
 * Keys under the prefix that are not source keys (`<org uuid>/<sha256>`) are
 * not Cerebro's and are skipped.
 */
export class S3BackupObjectStore implements BackupObjectStore {
  readonly kind = "s3" as const;
  /** Keys under the prefix that were not source keys, from the last `list()`. */
  skipped = 0;

  constructor(readonly store: S3SourceStore) {}

  async *list(): AsyncIterable<{ organizationId: string; sha256: string }> {
    const { bucket, prefix } = this.store.config;
    this.skipped = 0;
    let token: string | undefined;
    do {
      const res = await this.store.client.send(
        new ListObjectsV2Command({ Bucket: bucket, ...(prefix ? { Prefix: prefix } : {}), ...(token ? { ContinuationToken: token } : {}) }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key?.startsWith(prefix)) continue;
        try {
          const parsed = parseSourceKey(o.Key.slice(prefix.length));
          yield { organizationId: parsed.organizationId, sha256: parsed.sha256 };
        } catch {
          this.skipped++;
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async download(organizationId: string, sha256: string, file: string): Promise<number | null> {
    const key = parseSourceKey(`${organizationId}/${sha256}`).key;
    let body: unknown;
    try {
      const res = await this.store.client.send(new GetObjectCommand({ Bucket: this.store.config.bucket, Key: this.store.objectKey(key) }));
      body = res.Body;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.$metadata?.httpStatusCode === 404 || e.name === "NoSuchKey") return null;
      throw err;
    }
    if (!(body instanceof Readable)) throw new Error("source object has no readable body");
    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    const partial = `${file}.partial`;
    try {
      await pipeline(body, tap, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
      if (hash.digest("hex") !== sha256) throw new Error(`source object failed integrity check: ${key}`);
      await rename(partial, file);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return bytes;
  }

  async upload(organizationId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    const put = await this.store.put(organizationId, bytes);
    if (put.sha256 !== sha256) throw new Error(`backup object failed integrity check: ${organizationId}/${sha256}`);
  }
}

/** The backup object store the environment selects: the S3 store when `CEREBRO_OBJECT_STORE=s3`, else `undefined` (local directory copy). */
export function backupObjectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): S3BackupObjectStore | undefined {
  return objectStoreKind(env) === "s3" ? new S3BackupObjectStore(new S3SourceStore(s3ConfigFromEnv(env))) : undefined;
}
