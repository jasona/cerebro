/**
 * Backup and restore of the database and the private object store (W4).
 *
 * A backup is a directory:
 *
 *   manifest.json            format version, time, database kind, applied
 *                            migrations, object count and bytes (no content)
 *   database.pglite.tar.gz   PGlite: `dumpDataDir("gzip")`
 *   database.pgdump          Postgres: `pg_dump --format=custom`
 *   objects/<org>/<sha256>   every source object, from the local store
 *                            directory or, with `objectStore`, from an
 *                            S3-compatible bucket (same layout either way)
 *
 * PGlite allows one process per data directory: stop the web app before
 * backing up or restoring it. Restoring never deletes the current PGlite data
 * directory or object directory; they are moved aside to
 * `<dir>.pre-restore-<timestamp>`. Restoring Postgres uses
 * `pg_restore --clean --if-exists` into the target database; when the target
 * already has the `vector` extension it is left in place, so the
 * non-superuser owner role (`db:provision`) can restore.
 *
 * With an `objectStore` (the S3 store, D25), objects are streamed from the
 * bucket into `objects/<org>/<sha256>` and verified against their sha256 on
 * the way out; a restore verifies each file's sha256 again and writes it back
 * with the store's immutable put. Objects already in the bucket are kept (a
 * restore never deletes bucket objects).
 *
 * Postgres tools come from `PG_BIN_DIR` when set, else from PATH.
 * `pruneBackups` keeps the newest N complete backups (D26). The CLI
 * (`packages/domain/src/cli/backup.ts`) adds the S3 object store and the
 * optional off-site copy; scheduling is a Coolify scheduled task.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createDatabase, defaultPgliteDir, findRepoRoot } from "./client";

const run = promisify(execFile);

export const BACKUP_FORMAT_VERSION = 1;
const PGLITE_FILE = "database.pglite.tar.gz";
const PGDUMP_FILE = "database.pgdump";
const OBJECTS_DIR = "objects";

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  database: { kind: "pglite" | "postgres"; file: string; bytes: number };
  migrations: string[];
  objects: {
    files: number;
    bytes: number;
    /** Where the objects came from (absent in older backups: `local`). */
    store?: "local" | "s3";
    /** S3 only: objects listed but gone before they could be copied (for example a source deleted during the backup). */
    missing?: number;
  };
}

/**
 * An object store a backup can export from and restore into (the S3 source
 * store implements it in `@cerebro/domain`, `sources/backup-objects.ts`).
 * Keys are content-addressed: `<organizationId>/<sha256>`.
 */
export interface BackupObjectStore {
  readonly kind: "s3";
  /** Every source object under the store's prefix. */
  list(): AsyncIterable<{ organizationId: string; sha256: string }>;
  /**
   * Stream one object into `file` (mode 0600), verifying its sha256 while
   * writing. Returns the byte count, or `null` if the object no longer exists.
   * Throws, leaving no file behind, if the content does not match the hash.
   */
  download(organizationId: string, sha256: string, file: string): Promise<number | null>;
  /** Write `bytes` with the store's immutable put; must yield key `<organizationId>/<sha256>`. */
  upload(organizationId: string, sha256: string, bytes: Uint8Array): Promise<void>;
}

const OBJECT_ORG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_SHA = /^[0-9a-f]{64}$/;

/** sha256 (hex) of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface BackupTarget {
  /** Postgres URL; when unset (and DATABASE_URL unset) PGlite is used. */
  url?: string;
  /** PGlite data directory (default `.data/pglite` or CEREBRO_PGLITE_DIR). */
  dataDir?: string;
  /** Object store directory (default `.data/objects` or CEREBRO_OBJECTS_DIR). */
  objectsDir?: string;
  /** Directory containing pg_dump / pg_restore (default PG_BIN_DIR, then PATH). */
  pgBinDir?: string;
  /** Back up and restore source objects through this store (S3) instead of `objectsDir`. */
  objectStore?: BackupObjectStore;
}

export const defaultObjectsDir = (): string => process.env.CEREBRO_OBJECTS_DIR ?? join(findRepoRoot(), ".data", "objects");
export const defaultBackupRoot = (): string => process.env.CEREBRO_BACKUP_DIR ?? join(findRepoRoot(), ".data", "backups");

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function resolveTarget(t: BackupTarget) {
  const url = t.url !== undefined ? t.url : (process.env.DATABASE_URL ?? "");
  return {
    url,
    kind: (url ? "postgres" : "pglite") as "pglite" | "postgres",
    dataDir: resolve(t.dataDir ?? defaultPgliteDir()),
    objectsDir: resolve(t.objectsDir ?? defaultObjectsDir()),
    pgBinDir: t.pgBinDir ?? process.env.PG_BIN_DIR,
    objectStore: t.objectStore,
  };
}

const pgTool = (binDir: string | undefined, name: string) => (binDir ? join(binDir, name) : name);

/**
 * Split a Postgres URL into a password-free `--dbname` value and a
 * `PGPASSWORD` environment entry. Command lines are visible to other local
 * users (`ps`, /proc) and are quoted in child-process error messages, so the
 * password must never be an argument.
 */
export function pgConnectionForTool(url: string): { dbname: string; env: Record<string, string> } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Deliberately do not echo the value: it may contain a password.
    throw new Error("DATABASE_URL is not a valid postgres:// URL");
  }
  const env: Record<string, string> = {};
  const fromQuery = u.searchParams.get("password");
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  else if (fromQuery) env.PGPASSWORD = fromQuery;
  u.password = "";
  u.searchParams.delete("password");
  return { dbname: u.toString(), env };
}

/**
 * Run pg_dump / pg_restore against `url` without exposing its password.
 * Failures are reported with the tool, exit code and (redacted, truncated)
 * stderr only: never the command line, which `execFile` would otherwise quote.
 */
export async function runPgTool(binDir: string | undefined, name: "pg_dump" | "pg_restore", url: string, args: string[]): Promise<void> {
  const { dbname, env } = pgConnectionForTool(url);
  try {
    await run(pgTool(binDir, name), [`--dbname=${dbname}`, ...args], { env: { ...process.env, ...env } });
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown };
    let detail = typeof e.stderr === "string" ? e.stderr.trim().slice(-500) : "";
    if (env.PGPASSWORD) detail = detail.split(env.PGPASSWORD).join("***");
    const code = typeof e.code === "number" || typeof e.code === "string" ? ` (${e.code})` : "";
    throw new Error(`${name} failed${code}${detail ? `: ${detail}` : ""}`);
  }
}

async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

async function appliedMigrationsPg(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>("select id from schema_migrations order by id");
    return res.rows.map((r) => r.id);
  } catch {
    return [];
  } finally {
    await client.end();
  }
}

/** Write a backup of the database and object store into a new directory. Returns its path and manifest. */
export async function backupDatabase(target: BackupTarget = {}, outDir?: string): Promise<{ dir: string; manifest: BackupManifest }> {
  const t = resolveTarget(target);
  const dir = resolve(outDir ?? join(defaultBackupRoot(), stamp()));
  if (existsSync(dir) && (await readdir(dir)).length) throw new Error(`backup directory is not empty: ${dir}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // A backup holds every tenant's data: keep it private even if the directory already existed.
  await chmod(dir, 0o700);

  let file: string;
  let migrations: string[];
  if (t.kind === "pglite") {
    if (!existsSync(t.dataDir)) throw new Error(`PGlite data directory not found: ${t.dataDir}`);
    const handle = await createDatabase({ url: "", dataDir: t.dataDir });
    try {
      const raw = handle.raw as PGlite;
      migrations = (await raw.query<{ id: string }>("select id from schema_migrations order by id").catch(() => ({ rows: [] }))).rows.map((r) => r.id);
      const blob = await raw.dumpDataDir("gzip");
      file = PGLITE_FILE;
      await writeFile(join(dir, file), new Uint8Array(await blob.arrayBuffer()), { mode: 0o600 });
    } finally {
      await handle.close();
    }
  } else {
    file = PGDUMP_FILE;
    migrations = await appliedMigrationsPg(t.url);
    await runPgTool(t.pgBinDir, "pg_dump", t.url, ["--format=custom", "--no-owner", `--file=${join(dir, file)}`]);
    await chmod(join(dir, file), 0o600);
  }

  let objects: BackupManifest["objects"];
  if (t.objectStore) {
    objects = { ...(await exportObjects(t.objectStore, join(dir, OBJECTS_DIR))), store: t.objectStore.kind };
  } else {
    if (existsSync(t.objectsDir)) await cp(t.objectsDir, join(dir, OBJECTS_DIR), { recursive: true });
    else await mkdir(join(dir, OBJECTS_DIR));
    objects = { ...(await dirStats(join(dir, OBJECTS_DIR))), store: "local" };
  }

  // Written last: a manifest marks a complete backup (pruning relies on it).
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    database: { kind: t.kind, file, bytes: (await stat(join(dir, file))).size },
    migrations,
    objects,
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, manifest };
}

/** Stream every object of `store` into `<objectsDir>/<org>/<sha256>`, verifying each hash. */
async function exportObjects(store: BackupObjectStore, objectsDir: string): Promise<{ files: number; bytes: number; missing: number }> {
  await mkdir(objectsDir, { mode: 0o700 });
  let files = 0;
  let bytes = 0;
  let missing = 0;
  for await (const { organizationId, sha256 } of store.list()) {
    if (!OBJECT_ORG.test(organizationId) || !OBJECT_SHA.test(sha256)) throw new Error("object store listed an invalid source key");
    const orgDir = join(objectsDir, organizationId);
    await mkdir(orgDir, { recursive: true, mode: 0o700 });
    const size = await store.download(organizationId, sha256, join(orgDir, sha256));
    if (size === null) {
      missing++;
      continue;
    }
    files++;
    bytes += size;
  }
  return { files, bytes, missing };
}

/** Every `<org>/<sha256>` object file in a backup's objects directory; throws on anything else. */
async function* backupObjectFiles(objectsDir: string): AsyncGenerator<{ organizationId: string; sha256: string; path: string }> {
  if (!existsSync(objectsDir)) return;
  for (const org of await readdir(objectsDir, { withFileTypes: true })) {
    if (!org.isDirectory() || !OBJECT_ORG.test(org.name)) throw new Error(`unexpected entry in backup objects: ${org.name}`);
    for (const obj of await readdir(join(objectsDir, org.name), { withFileTypes: true })) {
      if (!obj.isFile() || !OBJECT_SHA.test(obj.name)) throw new Error(`unexpected entry in backup objects: ${org.name}/${obj.name}`);
      yield { organizationId: org.name, sha256: obj.name, path: join(objectsDir, org.name, obj.name) };
    }
  }
}

/** Write every backup object back through the store's immutable put, verifying each hash first. */
async function importObjects(store: BackupObjectStore, objectsDir: string): Promise<number> {
  let count = 0;
  for await (const { organizationId, sha256, path } of backupObjectFiles(objectsDir)) {
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`backup object failed integrity check: ${organizationId}/${sha256}`);
    await store.upload(organizationId, sha256, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    count++;
  }
  return count;
}

/**
 * Check a backup without restoring it: the manifest, and every object file
 * against its sha256 name and the manifest's counts. Throws on any mismatch.
 */
export async function verifyBackup(dir: string): Promise<{ manifest: BackupManifest; files: number; bytes: number }> {
  const manifest = await readBackupManifest(resolve(dir));
  const dbFile = await stat(join(resolve(dir), manifest.database.file));
  if (dbFile.size !== manifest.database.bytes) throw new Error("backup database file size does not match the manifest");
  let files = 0;
  let bytes = 0;
  for await (const { organizationId, sha256, path } of backupObjectFiles(join(resolve(dir), OBJECTS_DIR))) {
    if ((await sha256File(path)) !== sha256) throw new Error(`backup object failed integrity check: ${organizationId}/${sha256}`);
    files++;
    bytes += (await stat(path)).size;
  }
  if (files !== manifest.objects.files || bytes !== manifest.objects.bytes) throw new Error("backup objects do not match the manifest counts");
  return { manifest, files, bytes };
}

export async function readBackupManifest(dir: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`unsupported backup format version ${m.formatVersion}`);
  // The file name is fixed per kind; never follow a manifest outside the backup directory.
  const expected = m.database?.kind === "pglite" ? PGLITE_FILE : m.database?.kind === "postgres" ? PGDUMP_FILE : null;
  if (!expected || m.database.file !== expected) throw new Error("backup manifest names an unexpected database file");
  return m;
}

/** Move a directory aside (never delete it) so a restore can be undone by hand. */
async function moveAside(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const aside = `${dir}.pre-restore-${stamp()}`;
  await rename(dir, aside);
  return aside;
}

/** The archive's table of contents (`pg_restore --list`); reads the file only, no connection. */
async function pgRestoreList(binDir: string | undefined, file: string): Promise<string> {
  try {
    return (await run(pgTool(binDir, "pg_restore"), ["--list", file], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new Error(`pg_restore --list failed${typeof code === "number" ? ` (${code})` : ""}`);
  }
}

/** Comment out extension entries (`EXTENSION - vector`, `COMMENT - EXTENSION vector`) of a TOC list. */
export function withoutExtensionEntries(list: string): string {
  return list
    .split("\n")
    .map((line) => (/^\d+;\s+\d+\s+\d+\s+(?:EXTENSION|COMMENT\s+-\s+EXTENSION)\s/.test(line) ? `;${line}` : line))
    .join("\n");
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Where the previous PGlite data directory / object directory were moved. */
  movedAside: { dataDir: string | null; objectsDir: string | null };
  /** Objects written back through `objectStore` (S3); 0 for the local store. */
  objectsRestored: number;
}

/**
 * Restore a backup directory into the target. The backup's database kind must
 * match the target's (PGlite backups restore into PGlite, Postgres into Postgres).
 */
export async function restoreDatabase(dir: string, target: BackupTarget = {}): Promise<RestoreResult> {
  const t = resolveTarget(target);
  const manifest = await readBackupManifest(resolve(dir));
  if (manifest.database.kind !== t.kind) {
    throw new Error(`backup is ${manifest.database.kind} but the target is ${t.kind}`);
  }
  const movedAside = { dataDir: null as string | null, objectsDir: null as string | null };

  if (t.kind === "pglite") {
    const bytes = await readFile(join(dir, manifest.database.file));
    movedAside.dataDir = await moveAside(t.dataDir);
    const handle = await createDatabase({ url: "", dataDir: t.dataDir, loadDataDir: new Blob([bytes]) });
    try {
      await (handle.raw as PGlite).query("select 1");
    } finally {
      await handle.close();
    }
  } else {
    // The runtime role is cluster-wide; grants in the dump need it to exist.
    const client = new pg.Client({ connectionString: t.url });
    await client.connect();
    let hasVector: boolean;
    try {
      await client.query(
        "do $$ begin if not exists (select 1 from pg_roles where rolname = 'cerebro_app') then create role cerebro_app nologin nobypassrls; end if; end $$",
      );
      hasVector = ((await client.query("select 1 from pg_extension where extname = 'vector'")).rowCount ?? 0) > 0;
    } finally {
      await client.end();
    }
    const dump = join(dir, manifest.database.file);
    // When the target already has pgvector (a provisioned database), leave the
    // extension alone: `--clean` would otherwise drop and recreate it, which
    // only its owner (a superuser) may do, so the non-superuser owner role
    // could not restore. Every table is still replaced.
    let listDir: string | null = null;
    try {
      const listArgs: string[] = [];
      if (hasVector) {
        listDir = await mkdtemp(join(tmpdir(), "cerebro-restore-"));
        const list = join(listDir, "toc.list");
        await writeFile(list, withoutExtensionEntries(await pgRestoreList(t.pgBinDir, dump)), { mode: 0o600 });
        listArgs.push(`--use-list=${list}`);
      }
      await runPgTool(t.pgBinDir, "pg_restore", t.url, [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--exit-on-error",
        "--single-transaction",
        ...listArgs,
        dump,
      ]);
    } finally {
      if (listDir) await rm(listDir, { recursive: true, force: true });
    }
  }

  const src = join(dir, OBJECTS_DIR);
  if (t.objectStore) {
    // Immutable puts: objects already in the bucket are kept, missing ones written back.
    return { manifest, movedAside, objectsRestored: await importObjects(t.objectStore, src) };
  }
  movedAside.objectsDir = await moveAside(t.objectsDir);
  if (existsSync(src)) await cp(src, t.objectsDir, { recursive: true });
  else await mkdir(t.objectsDir, { recursive: true });
  return { manifest, movedAside, objectsRestored: 0 };
}

/** `CEREBRO_BACKUP_KEEP`: complete backups to keep (default 14, D26); `off` or `0` disables pruning. */
export function backupKeepFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CEREBRO_BACKUP_KEEP?.trim().toLowerCase();
  if (!raw) return 14;
  if (raw === "off" || raw === "0") return null;
  if (!/^\d+$/.test(raw)) throw new Error('CEREBRO_BACKUP_KEEP must be a positive integer or "off"');
  return Number(raw);
}

/**
 * Keep the newest `keep` complete backups directly inside `root` and delete
 * the older ones. Only directories with a readable Cerebro manifest are
 * counted or deleted; anything else (incomplete backups, other files, a
 * restore's moved-aside directories) is never touched. Returns what was deleted.
 */
export async function pruneBackups(root: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keep must be a positive integer");
  const dir = resolve(root);
  if (!existsSync(dir)) return [];
  const complete: { path: string; created: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      const created = Date.parse((await readBackupManifest(path)).createdAt);
      if (!Number.isNaN(created)) complete.push({ path, created });
    } catch {
      // Not a complete Cerebro backup: left alone.
    }
  }
  complete.sort((a, b) => b.created - a.created || b.path.localeCompare(a.path));
  const doomed = complete.slice(keep).map((c) => c.path);
  for (const path of doomed) await rm(path, { recursive: true, force: true });
  return doomed;
}
