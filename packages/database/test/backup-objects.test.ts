/**
 * Backups through a `BackupObjectStore` (the S3 store's shape, D26), with an
 * in-memory fake; pruning (CEREBRO_BACKUP_KEEP); and offline verification.
 * The S3 implementation runs against a live server in
 * packages/domain/src/sources/backup-s3.integration.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backupDatabase,
  backupKeepFromEnv,
  pruneBackups,
  restoreDatabase,
  verifyBackup,
  type BackupManifest,
  type BackupObjectStore,
} from "../src/backup";
import { createDatabase, migrate } from "../src/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

class MemoryObjectStore implements BackupObjectStore {
  readonly kind = "s3" as const;
  objects = new Map<string, Uint8Array>();
  /** Keys that disappear between list and download. */
  vanish = new Set<string>();
  /** Keys whose stored bytes no longer match their hash. */
  corrupt = new Set<string>();
  puts: string[] = [];

  add(org: string, text: string): string {
    const bytes = new TextEncoder().encode(text);
    const key = `${org}/${sha(bytes)}`;
    this.objects.set(key, bytes);
    return key;
  }

  async *list() {
    for (const key of [...this.objects.keys()].sort()) {
      const [organizationId, sha256] = key.split("/") as [string, string];
      yield { organizationId, sha256 };
    }
  }

  async download(organizationId: string, sha256: string, file: string): Promise<number | null> {
    const key = `${organizationId}/${sha256}`;
    if (this.vanish.has(key)) return null;
    const bytes = this.corrupt.has(key) ? new TextEncoder().encode("tampered") : this.objects.get(key)!;
    if (sha(bytes) !== sha256) throw new Error(`source object failed integrity check: ${key}`);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    return bytes.byteLength;
  }

  async upload(organizationId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    if (sha(bytes) !== sha256) throw new Error("hash mismatch");
    const key = `${organizationId}/${sha256}`;
    this.puts.push(key);
    if (!this.objects.has(key)) this.objects.set(key, bytes);
  }
}

let root: string;
let dataDir: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cerebro-backup-objects-"));
  dataDir = join(root, "data");
  const h = await createDatabase({ url: "", dataDir });
  await migrate(h);
  await h.close();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("backups through an object store", () => {
  it("exports every object, verifies it, and restores with immutable puts", async () => {
    const store = new MemoryObjectStore();
    const a = store.add(ORG, "alpha bytes");
    const b = store.add(ORG2, "beta bytes");
    const objectsDir = join(root, "unused-objects");
    const { dir, manifest } = await backupDatabase({ url: "", dataDir, objectsDir, objectStore: store }, join(root, "s3-backup"));
    expect(manifest.objects).toEqual({ files: 2, bytes: "alpha bytes".length + "beta bytes".length, missing: 0, store: "s3" });
    expect(await readFile(join(dir, "objects", a), "utf8")).toBe("alpha bytes");
    expect((await stat(join(dir, "objects", b))).mode & 0o077).toBe(0);
    // The local objects directory is not involved.
    expect(existsSync(objectsDir)).toBe(false);
    expect((await verifyBackup(dir)).files).toBe(2);

    // Restore into an empty store (a fresh bucket): everything comes back.
    const fresh = new MemoryObjectStore();
    const res = await restoreDatabase(dir, { url: "", dataDir, objectsDir, objectStore: fresh });
    expect(res.objectsRestored).toBe(2);
    expect([...fresh.objects.keys()].sort()).toEqual([a, b].sort());
    expect(res.movedAside.objectsDir).toBeNull();

    // Restore into the original store: existing and newer objects are kept.
    const later = store.add(ORG, "written after the backup");
    await restoreDatabase(dir, { url: "", dataDir, objectsDir, objectStore: store });
    expect(store.objects.has(later)).toBe(true);
    expect(store.puts.sort()).toEqual([a, b].sort());
  });

  it("records objects deleted during the backup as missing, and fails on a hash mismatch", async () => {
    const store = new MemoryObjectStore();
    const gone = store.add(ORG, "deleted mid-backup");
    store.add(ORG, "kept");
    store.vanish.add(gone);
    const { manifest } = await backupDatabase({ url: "", dataDir, objectStore: store }, join(root, "vanish-backup"));
    expect(manifest.objects).toMatchObject({ files: 1, missing: 1 });

    const bad = new MemoryObjectStore();
    bad.corrupt.add(bad.add(ORG, "will be tampered"));
    const out = join(root, "corrupt-backup");
    await expect(backupDatabase({ url: "", dataDir, objectStore: bad }, out)).rejects.toThrow("integrity");
    // No manifest: an incomplete backup is never mistaken for a complete one.
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });

  it("refuses to restore a tampered or unexpected backup object", async () => {
    const store = new MemoryObjectStore();
    const key = store.add(ORG, "original");
    const { dir } = await backupDatabase({ url: "", dataDir, objectStore: store }, join(root, "tamper-backup"));
    await writeFile(join(dir, "objects", key), "tampered");
    await expect(verifyBackup(dir)).rejects.toThrow("integrity");
    const target = new MemoryObjectStore();
    await expect(restoreDatabase(dir, { url: "", dataDir, objectStore: target })).rejects.toThrow("integrity");
    expect(target.objects.size).toBe(0);

    const { dir: dir2 } = await backupDatabase({ url: "", dataDir, objectStore: new MemoryObjectStore() }, join(root, "odd-backup"));
    await mkdir(join(dir2, "objects", ORG), { recursive: true });
    await writeFile(join(dir2, "objects", ORG, "..notahash"), "x");
    await expect(restoreDatabase(dir2, { url: "", dataDir, objectStore: new MemoryObjectStore() })).rejects.toThrow("unexpected entry");
  });

  it("restores a local-store backup into an object store (same layout)", async () => {
    const objectsDir = join(root, "local-objects");
    await mkdir(join(objectsDir, ORG), { recursive: true });
    await writeFile(join(objectsDir, ORG, sha("local bytes")), "local bytes");
    const { dir, manifest } = await backupDatabase({ url: "", dataDir, objectsDir }, join(root, "local-backup"));
    expect(manifest.objects.store).toBe("local");
    const target = new MemoryObjectStore();
    const res = await restoreDatabase(dir, { url: "", dataDir, objectsDir, objectStore: target });
    expect(res.objectsRestored).toBe(1);
    expect(target.objects.has(`${ORG}/${sha("local bytes")}`)).toBe(true);
  });
});

describe("pruning (CEREBRO_BACKUP_KEEP)", () => {
  async function fakeBackup(parent: string, name: string, createdAt: string) {
    const dir = join(parent, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "database.pgdump"), "x");
    const m: BackupManifest = {
      formatVersion: 1,
      createdAt,
      database: { kind: "postgres", file: "database.pgdump", bytes: 1 },
      migrations: [],
      objects: { files: 0, bytes: 0 },
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(m));
  }

  it("keeps the newest N complete backups and never touches anything else", async () => {
    const parent = join(root, "prune");
    for (let day = 1; day <= 5; day++) await fakeBackup(parent, `2026-10-0${day}`, `2026-10-0${day}T03:00:00.000Z`);
    await mkdir(join(parent, "incomplete"), { recursive: true });
    await writeFile(join(parent, "incomplete", "database.pgdump"), "partial");
    await mkdir(join(parent, "not-cerebro"));
    await writeFile(join(parent, "not-cerebro", "manifest.json"), '{"formatVersion": 99}');
    await writeFile(join(parent, "notes.txt"), "keep me");

    const deleted = await pruneBackups(parent, 3);
    expect(deleted.map((d) => d.split("/").pop()).sort()).toEqual(["2026-10-01", "2026-10-02"]);
    expect((await readdir(parent)).sort()).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "incomplete", "not-cerebro", "notes.txt"]);
    expect(await pruneBackups(parent, 3)).toEqual([]);
    expect(await pruneBackups(join(root, "no-such-root"), 3)).toEqual([]);
    await expect(pruneBackups(parent, 0)).rejects.toThrow();
  });

  it("reads CEREBRO_BACKUP_KEEP (default 14, D26)", () => {
    expect(backupKeepFromEnv({})).toBe(14);
    expect(backupKeepFromEnv({ CEREBRO_BACKUP_KEEP: "7" })).toBe(7);
    expect(backupKeepFromEnv({ CEREBRO_BACKUP_KEEP: "off" })).toBeNull();
    expect(backupKeepFromEnv({ CEREBRO_BACKUP_KEEP: "0" })).toBeNull();
    expect(() => backupKeepFromEnv({ CEREBRO_BACKUP_KEEP: "-1" })).toThrow("CEREBRO_BACKUP_KEEP");
  });
});
