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
    await run(pgTool(t.pgBinDir, "pg_dump"), ["--format=custom", "--no-owner", `--file=${join(dir, file)}`, `--dbname=${t.url}`]);
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
    await run(pgTool(t.pgBinDir, "pg_restore"), [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
      `--dbname=${t.url}`,
      join(dir, manifest.database.file),
    ]);
  }

  movedAside.objectsDir = await moveAside(t.objectsDir);
  const src = join(dir, OBJECTS_DIR);
  if (existsSync(src)) await cp(src, t.objectsDir, { recursive: true });
  else await mkdir(t.objectsDir, { recursive: true });
  return { manifest, movedAside };
}
