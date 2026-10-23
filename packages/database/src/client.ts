import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;

/** Result shape shared by PGlite and node-postgres: both expose `rows`. */
export interface RowsResult<T> {
  rows: T[];
}
export interface CerebroQueryResultHKT extends PgQueryResultHKT {
  type: RowsResult<this["row"]>;
}

/** Drizzle database usable with either driver. `db.execute()` returns `{ rows }`. */
export type Database = PgDatabase<CerebroQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Drizzle transaction handle passed to `withAuthContext`/`withSystemContext` callbacks. */
export type Tx = PgTransaction<CerebroQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything that can run queries: a database or an open transaction. */
export type Executor = Database | Tx;

export type DatabaseKind = "pglite" | "postgres";

export interface DatabaseHandle {
  db: Database;
  kind: DatabaseKind;
  /** Underlying driver: the PGlite instance or the node-postgres Pool. */
  raw: PGlite | pg.Pool;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Postgres URL. Defaults to `DATABASE_URL`; when neither is set PGlite is used. */
  url?: string;
  /** PGlite data directory. Default `<repo>/.data/pglite` (or `CEREBRO_PGLITE_DIR`). */
  dataDir?: string;
  /** In-memory PGlite (tests). Ignored when a URL is in effect. */
  memory?: boolean;
  /** Load a PGlite data-dir dump (used by createTestDatabase). */
  loadDataDir?: Blob | File;
}

const handles = new WeakMap<object, DatabaseHandle>();

/** Look up the handle (driver kind, raw client) behind a Drizzle database. */
export function handleOf(db: Database | DatabaseHandle): DatabaseHandle {
  if ("db" in db && "kind" in db) return db as DatabaseHandle;
  const handle = handles.get(db);
  if (!handle) throw new Error("Database was not created by createDatabase()");
  return handle;
}

/** Repository root: nearest ancestor of cwd whose package.json declares workspaces. */
export function findRepoRoot(start: string = process.cwd()): string {
  // turbopackIgnore: runtime-only lookup; without it Next traces the whole project into the server output.
  let dir = resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).workspaces) return dir;
      } catch {
        // ignore unreadable package.json and keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(/*turbopackIgnore: true*/ start);
    dir = parent;
  }
}

export function defaultPgliteDir(): string {
  return process.env.CEREBRO_PGLITE_DIR ?? join(findRepoRoot(), ".data", "pglite");
}

export async function createDatabase(opts: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  // An explicit empty `url` forces PGlite even when DATABASE_URL is set.
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  let handle: DatabaseHandle;

  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzleNodePg(pool, { schema }) as unknown as Database;
    handle = { db, kind: "postgres", raw: pool, close: () => pool.end() };
  } else {
    const dataDir = opts.memory ? undefined : (opts.dataDir ?? defaultPgliteDir());
    // PGlite does not create missing parent directories.
    if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
    const client = await PGlite.create({
      ...(dataDir ? { dataDir } : {}),
      ...(opts.loadDataDir ? { loadDataDir: opts.loadDataDir } : {}),
      extensions: { vector },
    });
    const db = drizzlePglite(client, { schema }) as unknown as Database;
    handle = { db, kind: "pglite", raw: client, close: () => client.close() };
  }
  handles.set(handle.db, handle);
  return handle;
}

/**
 * Whether background jobs should run inside the web process. PGlite allows one
 * process per data directory, so `npm run worker` alongside `npm run dev`
 * requires DATABASE_URL; under PGlite the web process runs jobs itself.
 */
export const runJobsInProcess = (handle: Pick<DatabaseHandle, "kind">): boolean => handle.kind === "pglite";

export interface AuthContext {
  userId: string;
  /** Null only for cross-company lookups of the user's own memberships. */
  organizationId: string | null;
  connectionId?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction as the `cerebro_app` runtime role with
 * transaction-local `app.user_id` / `app.org_id`. All RLS policies key off
 * these settings. Never use the outer `db` inside `fn` (see README in index.ts).
 */
export async function withAuthContext<T>(db: Database, ctx: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(ctx.userId)) throw new Error("withAuthContext: userId must be a uuid");
  if (ctx.organizationId !== null && !UUID.test(ctx.organizationId)) {
    throw new Error("withAuthContext: organizationId must be a uuid or null");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role cerebro_app`);
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true),
                 set_config('app.org_id', ${ctx.organizationId ?? ""}, true),
                 set_config('app.connection_id', ${ctx.connectionId ?? ""}, true)`,
    );
    return fn(tx as Tx);
  });
}

/**
 * Run `fn` in an owner transaction that bypasses RLS.
 *
 * RESTRICTED: only migrations, seed, worker job claiming/completion, retrieval
 * projection writes by the indexer, and narrow identity lookups (resolving an
 * auth subject, identity link or connection-token hash to a user, and the
 * invitation-gated first-sign-in provisioning of `users`/`user_identities`).
 * Every use in domain code must carry a comment justifying it.
 */
export async function withSystemContext<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as Tx));
}

declare global {
  // eslint-disable-next-line no-var
  var __cerebroDatabase: Promise<DatabaseHandle> | undefined;
}

/**
 * Process-wide database, cached on globalThis so Next.js hot reload does not
 * open the PGlite data directory twice. Under PGlite, pending migrations are
 * applied on first use; with DATABASE_URL run `npm run db:migrate` instead.
 */
export function getDatabase(): Promise<DatabaseHandle> {
  globalThis.__cerebroDatabase ??= (async () => {
    const handle = await createDatabase();
    if (handle.kind === "pglite") {
      const { migrate } = await import("./migrate");
      await migrate(handle);
    }
    return handle;
  })().catch((err: unknown) => {
    globalThis.__cerebroDatabase = undefined;
    throw err;
  });
  return globalThis.__cerebroDatabase;
}
