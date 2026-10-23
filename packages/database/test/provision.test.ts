/**
 * `db:provision` against a PostgreSQL server (runs when TEST_DATABASE_URL is a
 * superuser URL, as in CI): a non-superuser owner prepared by provisioning can
 * migrate, seed and serve runtime-role queries under row-level security.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, migrate, seedOrganizations, withAuthContext } from "../src/index";
import { parseProvisionTarget, provisionDatabase } from "../src/provision";

const adminUrl = process.env.TEST_DATABASE_URL;

describe("parseProvisionTarget", () => {
  it("reads the owner role, password and database from DATABASE_URL", () => {
    expect(parseProvisionTarget("postgres://cerebro:p%40ss@db:5432/cerebro")).toEqual({
      role: "cerebro",
      password: "p@ss",
      database: "cerebro",
    });
  });

  it("refuses URLs without a role or database, or that are not postgres URLs", () => {
    expect(() => parseProvisionTarget("postgres://db:5432/cerebro")).toThrow(/owner role/);
    expect(() => parseProvisionTarget("postgres://cerebro:x@db:5432/")).toThrow(/database/);
    expect(() => parseProvisionTarget("mysql://cerebro:x@db/cerebro")).toThrow(/postgres/);
    expect(() => parseProvisionTarget("postgres://a;drop:x@db/cerebro")).toThrow(/owner role/);
  });
});

describe.skipIf(!adminUrl)("provisionDatabase (PostgreSQL server)", () => {
  const suffix = randomBytes(4).toString("hex");
  const role = `cerebro_prov_owner_${suffix}`;
  const database = `cerebro_prov_${suffix}`;
  const password = randomBytes(12).toString("hex");
  const ownerUrl = (() => {
    const u = new URL(adminUrl!);
    u.username = role;
    u.password = password;
    u.pathname = `/${database}`;
    return u.toString();
  })();

  afterAll(async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`drop database if exists "${database}" with (force)`);
      await c.query(`drop role if exists "${role}"`);
    } finally {
      await c.end();
    }
  });

  it("prepares a non-superuser owner that can migrate and run under RLS, idempotently", async () => {
    const first = await provisionDatabase({ adminUrl: adminUrl!, databaseUrl: ownerUrl });
    expect(first).toEqual({ role, database, roleAction: "created", databaseAction: "created", extension: "created" });
    const again = await provisionDatabase({ adminUrl: adminUrl!, databaseUrl: ownerUrl });
    expect(again).toMatchObject({ roleAction: "updated", databaseAction: "existing", extension: "existing" });

    const h = await createDatabase({ url: ownerUrl });
    try {
      const me = await h.db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        sql`select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user`,
      );
      expect(me.rows[0]).toEqual({ rolsuper: false, rolbypassrls: true, rolcreaterole: true });

      expect((await migrate(h)).length).toBeGreaterThan(0);
      expect(await migrate(h)).toEqual([]);
      const seed = await seedOrganizations(h.db);

      // The owner can switch to cerebro_app, and RLS then limits rows to the
      // user's own companies.
      const visible = await withAuthContext(h.db, { userId: seed.users.riley, organizationId: null }, (tx) =>
        tx.execute<{ slug: string }>(sql`select slug from organizations order by slug`),
      );
      expect(visible.rows.map((r) => r.slug)).toEqual(["acme"]);
    } finally {
      await h.close();
    }
  });
});
