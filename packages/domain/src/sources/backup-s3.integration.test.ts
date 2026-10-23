import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { createDatabase, migrate } from "@cerebro/database";
import { backupDatabase, restoreDatabase, verifyBackup } from "@cerebro/database/backup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offsiteClient, offsiteConfigFromEnv, uploadBackupOffsite } from "../ops/backup-offsite";
import { S3BackupObjectStore } from "./backup-objects";
import { ensureBucket, s3ConfigFromEnv, S3SourceStore } from "./s3-store";
import { sha256Hex } from "./store";

/**
 * Backup, restore, bucket creation and the off-site copy against a real
 * S3-compatible server (CI: SeaweedFS). Same settings as
 * s3-store.integration.test.ts; skipped without TEST_S3_ENDPOINT. Creates
 * two throwaway buckets and removes them afterwards.
 */
const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const run = `${Date.now()}-${process.pid}`;

const storeFor = (bucket: string, prefix = "") =>
  new S3SourceStore(
    s3ConfigFromEnv({
      CEREBRO_S3_ENDPOINT: endpoint,
      CEREBRO_S3_BUCKET: bucket,
      CEREBRO_S3_REGION: process.env.TEST_S3_REGION ?? "us-east-1",
      CEREBRO_S3_FORCE_PATH_STYLE: process.env.TEST_S3_FORCE_PATH_STYLE ?? "true",
      CEREBRO_S3_PREFIX: prefix,
      AWS_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY,
    }),
  );

async function emptyAndDelete(store: S3SourceStore) {
  const { client, config } = store;
  for (;;) {
    const res = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }));
    if (!res.Contents?.length) break;
    for (const o of res.Contents) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: o.Key! }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: config.bucket })).catch(() => undefined);
}

describe.skipIf(!endpoint)("backups with the S3 store against a live S3-compatible server", () => {
  let root: string;
  let dataDir: string;
  let source: S3SourceStore;
  let fresh: S3SourceStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cerebro-backup-s3-"));
    dataDir = join(root, "data");
    const h = await createDatabase({ url: "", dataDir });
    await migrate(h);
    await h.close();
    source = storeFor(`cerebro-bk-${run}`, "sources");
    fresh = storeFor(`cerebro-rs-${run}`, "sources");
  });

  afterAll(async () => {
    await emptyAndDelete(source).catch(() => undefined);
    await emptyAndDelete(fresh).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("creates the bucket once and is idempotent (objects:init)", async () => {
    expect(await ensureBucket(source)).toBe("created");
    expect(await ensureBucket(source)).toBe("exists");
    expect(await ensureBucket(fresh)).toBe("created");
  });

  it("backs up every source object, verified, and restores it into a fresh bucket", async () => {
    const a = new TextEncoder().encode(`alpha ${run}`);
    const b = new TextEncoder().encode(`beta ${run}`);
    const putA = await source.put(ORG_A, a);
    const putB = await source.put(ORG_B, b);
    // Not a source key: skipped, never copied.
    await source.client.send(new PutObjectCommand({ Bucket: source.config.bucket, Key: "sources/readme.txt", Body: "not a source" }));

    const objectStore = new S3BackupObjectStore(source);
    const { dir, manifest } = await backupDatabase({ url: "", dataDir, objectStore }, join(root, "backup"));
    expect(manifest.objects).toEqual({ files: 2, bytes: a.byteLength + b.byteLength, missing: 0, store: "s3" });
    expect(objectStore.skipped).toBe(1);
    expect(await readFile(join(dir, "objects", putA.key))).toEqual(Buffer.from(a));
    expect((await readdir(join(dir, "objects"))).sort()).toEqual([ORG_A, ORG_B]);
    expect(await verifyBackup(dir)).toMatchObject({ files: 2 });

    const res = await restoreDatabase(dir, { url: "", dataDir, objectStore: new S3BackupObjectStore(fresh) });
    expect(res.objectsRestored).toBe(2);
    expect(await fresh.get(ORG_A, putA.key)).toEqual(a);
    expect(await fresh.get(ORG_B, putB.key)).toEqual(b);
    // A second restore is a no-op for existing objects (immutable put, 412).
    await expect(restoreDatabase(dir, { url: "", dataDir, objectStore: new S3BackupObjectStore(fresh) })).resolves.toMatchObject({ objectsRestored: 2 });
  });

  it("refuses an object whose bytes no longer match its hash, leaving no file", async () => {
    const bytes = new TextEncoder().encode(`tamper ${run}`);
    const put = await source.put(ORG_A, bytes);
    await source.client.send(new PutObjectCommand({ Bucket: source.config.bucket, Key: source.objectKey(put.key), Body: "tampered" }));
    const out = join(root, "tamper");
    await mkdir(out);
    await expect(new S3BackupObjectStore(source).download(ORG_A, sha256Hex(bytes), join(out, "obj"))).rejects.toThrow("integrity");
    expect(await readdir(out)).toEqual([]);
    expect(await new S3BackupObjectStore(source).download(ORG_A, "f".repeat(64), join(out, "missing"))).toBeNull();
  });

  it("uploads a finished backup off-site under a dated prefix, manifest included", async () => {
    const { dir } = await backupDatabase({ url: "", dataDir, objectStore: new S3BackupObjectStore(fresh) }, join(root, "2026-10-23T03-00-00-000Z"));
    const config = offsiteConfigFromEnv({
      CEREBRO_BACKUP_S3_ENDPOINT: endpoint,
      CEREBRO_BACKUP_S3_BUCKET: source.config.bucket,
      CEREBRO_BACKUP_S3_REGION: process.env.TEST_S3_REGION ?? "us-east-1",
      CEREBRO_BACKUP_S3_FORCE_PATH_STYLE: "true",
      CEREBRO_BACKUP_S3_PREFIX: `offsite-${run}`,
      CEREBRO_BACKUP_S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID,
      CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY,
    })!;
    const res = await uploadBackupOffsite(dir, config);
    expect(res.prefix).toBe(`offsite-${run}/2026-10-23T03-00-00-000Z/`);
    const listed = await offsiteClient(config).send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: res.prefix }));
    const keys = (listed.Contents ?? []).map((o) => o.Key!.slice(res.prefix.length)).sort();
    expect(keys).toContain("manifest.json");
    expect(keys).toContain("database.pglite.tar.gz");
    expect(keys.filter((k) => k.startsWith("objects/"))).toHaveLength(2);
    expect(res.files).toBe(keys.length);
    expect(existsSync(dir)).toBe(true);
  });
});
