import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { findRepoRoot, handleOf, type Database, type DatabaseHandle } from "./client";

export interface MigrationFile {
  id: string;
  sql: string;
  checksum: string;
}

export function migrationsDir(): string {
  const candidates: string[] = [];
  try {
    // `<this package>/migrations`, resolved at runtime. Not written as
    // `new URL("../migrations", import.meta.url)`: bundlers treat that as an
    // asset reference to resolve at build time (and Turbopack warns).
    candidates.push(resolve(/*turbopackIgnore: true*/ dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
  } catch {
    // bundlers may rewrite import.meta.url; fall back to the repo layout
  }
  candidates.push(join(findRepoRoot(), "packages", "database", "migrations"));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`migrations directory not found (tried ${candidates.join(", ")})`);
  return found;
}

export function loadMigrations(dir: string = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return { id: file.replace(/\.sql$/, ""), sql: text, checksum: createHash("sha256").update(text).digest("hex") };
    });
}

const TRACKING_TABLE = `create table if not exists schema_migrations (
  id text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

// Arbitrary constant shared by all Cerebro migrators.
const LOCK_KEY = 7_205_311_402;

/**
 * Apply pending migrations in filename order, each in its own transaction,
 * recording them in `schema_migrations`. Idempotent; refuses to continue if an
 * applied migration's file has changed. Uses the owner connection.
 */
export async function migrate(target: Database | DatabaseHandle): Promise<string[]> {
  const handle = handleOf(target);
  const files = loadMigrations();
  return handle.kind === "pglite" ? migratePglite(handle.raw as PGlite, files) : migratePostgres(handle.raw as pg.Pool, files);
}

function checkApplied(files: MigrationFile[], applied: Map<string, string>): MigrationFile[] {
  for (const [id, checksum] of applied) {
    const file = files.find((f) => f.id === id);
    if (file && file.checksum !== checksum) {
      throw new Error(`migration ${id} was modified after being applied; add a new migration instead`);
    }
  }
  return files.filter((f) => !applied.has(f.id));
}

async function migratePglite(client: PGlite, files: MigrationFile[]): Promise<string[]> {
  await client.exec(TRACKING_TABLE);
  const rows = (await client.query<{ id: string; checksum: string }>("select id, checksum from schema_migrations")).rows;
  const pending = checkApplied(files, new Map(rows.map((r) => [r.id, r.checksum])));
  for (const file of pending) {
    await client.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query("insert into schema_migrations (id, checksum) values ($1, $2)", [file.id, file.checksum]);
    });
  }
  return pending.map((f) => f.id);
}

async function migratePostgres(pool: pg.Pool, files: MigrationFile[]): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(TRACKING_TABLE);
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      const rows = (await client.query<{ id: string; checksum: string }>("select id, checksum from schema_migrations")).rows;
      const pending = checkApplied(files, new Map(rows.map((r) => [r.id, r.checksum])));
      for (const file of pending) {
        await client.query("begin");
        try {
          await client.query(file.sql);
          await client.query("insert into schema_migrations (id, checksum) values ($1, $2)", [file.id, file.checksum]);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback");
          throw err;
        }
      }
      return pending.map((f) => f.id);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
