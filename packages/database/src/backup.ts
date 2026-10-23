/**
 * Backup and restore of the database and the private object store (W4).
 *
 * A backup is a directory:
 *
 *   manifest.json            format version, time, database kind, applied
 *                            migrations, object count and bytes (no content)
 *   database.pglite.tar.gz   PGlite: `dumpDataDir("gzip")`
 *   database.pgdump          Postgres: `pg_dump --format=custom`
 *   objects/                 copy of the SourceStore directory
 *
 * PGlite allows one process per data directory: stop the web app before
 * backing up or restoring it. Restoring never deletes the current PGlite data
 * directory or object directory; they are moved aside to
 * `<dir>.pre-restore-<timestamp>`. Restoring Postgres uses
 * `pg_restore --clean --if-exists` into the target database.
 *
 * Postgres tools come from `PG_BIN_DIR` when set, else from PATH. Backup
 * scheduling, encryption at rest, off-site copies and retention of backups
 * depend on hosting (T10) and the retention policy (P11), neither of which is
 * decided; this module only produces and consumes local backup directories.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  objects: { files: number; bytes: number };
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
  }

  if (existsSync(t.objectsDir)) await cp(t.objectsDir, join(dir, OBJECTS_DIR), { recursive: true });
  else await mkdir(join(dir, OBJECTS_DIR));

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    database: { kind: t.kind, file, bytes: (await stat(join(dir, file))).size },
    migrations,
    objects: await dirStats(join(dir, OBJECTS_DIR)),
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, manifest };
}

export async function readBackupManifest(dir: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`unsupported backup format version ${m.formatVersion}`);
  return m;
}

/** Move a directory aside (never delete it) so a restore can be undone by hand. */
async function moveAside(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const aside = `${dir}.pre-restore-${stamp()}`;
  await rename(dir, aside);
  return aside;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Where the previous PGlite data directory / object directory were moved. */
  movedAside: { dataDir: string | null; objectsDir: string | null };
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
    try {
      await client.query(
        "do $$ begin if not exists (select 1 from pg_roles where rolname = 'cerebro_app') then create role cerebro_app nologin nobypassrls; end if; end $$",
      );
    } finally {
      await client.end();
    }
    await runPgTool(t.pgBinDir, "pg_restore", t.url, [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
      join(dir, manifest.database.file),
    ]);
  }

  movedAside.objectsDir = await moveAside(t.objectsDir);
  const src = join(dir, OBJECTS_DIR);
  if (existsSync(src)) await cp(src, t.objectsDir, { recursive: true });
  else await mkdir(t.objectsDir, { recursive: true });
  return { manifest, movedAside };
}
