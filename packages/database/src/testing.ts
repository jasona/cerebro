import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase, type DatabaseHandle } from "./client";
import { loadMigrations, migrate } from "./migrate";

/**
 * A fresh, migrated test database.
 *
 * - Default: in-memory PGlite. The first call per process migrates once and
 *   caches a data-dir dump; later calls restore from it. DATABASE_URL is
 *   ignored.
 * - `TEST_DATABASE_URL` set (an owner/superuser URL to a PostgreSQL server with
 *   pgvector): each call creates a new database `cerebro_test_<random>` from a
 *   migrated template database and drops it on `close()`. The template is
 *   named after the migration checksums, so it is built once per migration set
 *   and shared by all Vitest workers and runs.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  return serverUrl ? createPostgresTestDatabase(serverUrl) : createPgliteTestDatabase();
}

// ---------------------------------------------------------------------------
// PGlite

let pgliteTemplate: Promise<Blob> | undefined;

async function migratedPgliteTemplate(): Promise<Blob> {
  const handle = await createDatabase({ memory: true, url: "" });
  try {
    await migrate(handle);
    const { PGlite } = await import("@electric-sql/pglite");
    return await (handle.raw as InstanceType<typeof PGlite>).dumpDataDir("none");
  } finally {
    await handle.close();
  }
}

async function createPgliteTestDatabase(): Promise<DatabaseHandle> {
  pgliteTemplate ??= migratedPgliteTemplate().catch((err: unknown) => {
    pgliteTemplate = undefined;
    throw err;
  });
  return createDatabase({ memory: true, url: "", loadDataDir: await pgliteTemplate });
}

// ---------------------------------------------------------------------------
// PostgreSQL server

const TEMPLATE_PREFIX = "cerebro_test_tpl_";
// Arbitrary constant; serializes template builds across Vitest workers and runs.
const TEMPLATE_LOCK_KEY = 7_205_311_403;

let postgresTemplate: Promise<string> | undefined;

function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function withAdminClient<T>(serverUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Build (once) and return the name of the migrated template database. */
async function ensurePostgresTemplate(serverUrl: string): Promise<string> {
  const digest = createHash("sha256");
  for (const file of loadMigrations()) digest.update(`${file.id}:${file.checksum}\n`);
  const name = `${TEMPLATE_PREFIX}${digest.digest("hex").slice(0, 16)}`;

  await withAdminClient(serverUrl, async (admin) => {
    // Session-level advisory lock: concurrent workers wait here while one builds.
    await admin.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
      if (exists.rowCount) return;
      // Build under a temporary name and rename when complete, so a crashed
      // build never leaves a half-migrated template behind.
      const building = `${name}_building`;
      await admin.query(`drop database if exists ${quoteIdent(building)} with (force)`);
      await admin.query(`create database ${quoteIdent(building)}`);
      const handle = await createDatabase({ url: databaseUrl(serverUrl, building) });
      try {
        await migrate(handle);
      } finally {
        await handle.close();
      }
      await admin.query(`alter database ${quoteIdent(building)} rename to ${quoteIdent(name)}`);
      // Templates for older migration sets are no longer needed.
      const stale = await admin.query<{ datname: string }>(
        "select datname from pg_database where datname like $1 and datname <> $2",
        [`${TEMPLATE_PREFIX}%`, name],
      );
      for (const row of stale.rows) {
        await admin.query(`drop database if exists ${quoteIdent(row.datname)} with (force)`).catch(() => undefined);
      }
    } finally {
      await admin.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  });
  return name;
}

async function createPostgresTestDatabase(serverUrl: string): Promise<DatabaseHandle> {
  postgresTemplate ??= ensurePostgresTemplate(serverUrl).catch((err: unknown) => {
    postgresTemplate = undefined;
    throw err;
  });
  const template = await postgresTemplate;
  const name = `cerebro_test_${randomBytes(8).toString("hex")}`;
  await withAdminClient(serverUrl, (admin) =>
    admin.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`),
  );
  const handle = await createDatabase({ url: databaseUrl(serverUrl, name) });
  const closePool = handle.close;
  let closed: Promise<void> | undefined;
  handle.close = () =>
    (closed ??= (async () => {
      await closePool();
      await withAdminClient(serverUrl, (admin) => admin.query(`drop database if exists ${quoteIdent(name)} with (force)`));
    })());
  return handle;
}
