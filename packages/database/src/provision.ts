/**
 * One-time PostgreSQL provisioning for a server deployment (`npm run db:provision`).
 *
 * Migrations run as the owner role named in `DATABASE_URL`, which does not
 * need to be a superuser. A superuser must still prepare three things that
 * the owner cannot do itself (README "Real Postgres"):
 *
 * 1. the owner role, with LOGIN, CREATEROLE (migration 0003 creates
 *    `cerebro_app` and grants it to the owner) and BYPASSRLS (tables force
 *    row-level security and no policy targets the owner);
 * 2. the database, owned by that role;
 * 3. the `vector` extension in that database (pgvector is not a trusted
 *    extension).
 *
 * `provisionDatabase` does exactly that with an administrator URL and is
 * idempotent: an existing role is updated to the required attributes and
 * password, an existing database is reassigned to the owner, and the
 * extension is created only if missing. When the owner in `DATABASE_URL` is
 * the administrator itself, only the database and extension steps run. If
 * the cluster-wide runtime role `cerebro_app` already exists (created by
 * another role), the owner is granted it WITH ADMIN OPTION so migration 0003
 * can complete.
 *
 * Passwords are sent as SQL literals over the administrator connection and
 * never logged or returned.
 */
import pg from "pg";

export interface ProvisionInput {
  /** Superuser connection URL (any database on the target server, e.g. `postgres`). */
  adminUrl: string;
  /** The application's DATABASE_URL: owner role, its password and the database name. */
  databaseUrl: string;
}

export interface ProvisionResult {
  role: string;
  database: string;
  roleAction: "created" | "updated" | "is_admin";
  databaseAction: "created" | "existing";
  extension: "created" | "existing";
}

interface ParsedTarget {
  role: string;
  password: string;
  database: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export function parseProvisionTarget(databaseUrl: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a postgres:// URL");
  }
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!IDENTIFIER.test(role)) throw new Error("DATABASE_URL must name the owner role (user name)");
  if (!IDENTIFIER.test(database)) throw new Error("DATABASE_URL must name the database");
  return { role, password, database };
}

function withDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function provisionDatabase(input: ProvisionInput): Promise<ProvisionResult> {
  const target = parseProvisionTarget(input.databaseUrl);

  const { roleAction, databaseAction } = await withClient(input.adminUrl, async (c) => {
    const me = (await c.query<{ rolname: string; rolsuper: boolean }>(
      "select rolname, rolsuper from pg_roles where rolname = current_user",
    )).rows[0];
    if (!me?.rolsuper) throw new Error("the administrator URL must connect as a superuser");

    let roleAction: ProvisionResult["roleAction"];
    if (me.rolname === target.role) {
      roleAction = "is_admin";
    } else {
      if (!target.password) throw new Error("DATABASE_URL must include the owner's password");
      const exists = (await c.query("select 1 from pg_roles where rolname = $1", [target.role])).rowCount! > 0;
      const verb = exists ? "alter" : "create";
      const { rows } = await c.query<{ stmt: string }>(
        `select format('${verb} role %I with login createrole bypassrls nosuperuser password %L', $1::text, $2::text) as stmt`,
        [target.role, target.password],
      );
      await c.query(rows[0]!.stmt);
      roleAction = exists ? "updated" : "created";
      // The runtime role is cluster-wide. If another role created it (an
      // earlier owner, or a superuser migration), this owner cannot grant it
      // to itself in migration 0003 without ADMIN OPTION.
      if ((await c.query("select 1 from pg_roles where rolname = 'cerebro_app'")).rowCount! > 0) {
        const grant = await c.query<{ stmt: string }>(
          "select format('grant cerebro_app to %I with admin option', $1::text) as stmt",
          [target.role],
        );
        await c.query(grant.rows[0]!.stmt);
      }
    }

    const dbExists = (await c.query("select 1 from pg_database where datname = $1", [target.database])).rowCount! > 0;
    const { rows } = await c.query<{ stmt: string }>(
      dbExists
        ? "select format('alter database %I owner to %I', $1::text, $2::text) as stmt"
        : "select format('create database %I owner %I', $1::text, $2::text) as stmt",
      [target.database, target.role],
    );
    await c.query(rows[0]!.stmt);
    return { roleAction, databaseAction: dbExists ? ("existing" as const) : ("created" as const) };
  });

  const extension = await withClient(withDatabase(input.adminUrl, target.database), async (c) => {
    const had = (await c.query("select 1 from pg_extension where extname = 'vector'")).rowCount! > 0;
    if (!had) await c.query("create extension if not exists vector");
    return had ? ("existing" as const) : ("created" as const);
  });

  return { role: target.role, database: target.database, roleAction, databaseAction, extension };
}
