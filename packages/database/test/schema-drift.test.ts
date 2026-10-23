import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { createTestDatabase, type DatabaseHandle } from "../src/index";

/**
 * Migration drift check. Migrations are hand-written SQL and `schema.ts` is
 * hand-maintained Drizzle, so a freshly migrated database is compared with the
 * Drizzle declarations: tables, columns (type, nullability), primary keys,
 * foreign keys, unique constraints/indexes, and check/index names.
 */

let h: DatabaseHandle;
beforeAll(async () => {
  h = await createTestDatabase();
});
afterAll(async () => {
  await h.close();
});

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

/** Normalize Drizzle SQL type names to Postgres `format_type` output. */
function normalizeType(type: string): string {
  return type
    .replace(/^timestamp$/, "timestamp without time zone")
    .replace(/^varchar/, "character varying")
    .replace(/^serial$/, "integer")
    .replace(/^bigserial$/, "bigint");
}

const key = (columns: readonly string[]) => [...columns].sort().join(",");

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await h.db.execute<T & Record<string, unknown>>(query)).rows;
}

describe("migrations match schema.ts", () => {
  it("declares the same tables", async () => {
    const db = await rows<{ name: string }>(
      sql`select tablename as name from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual(db.map((r) => r.name).sort());
  });

  it("declares the same columns, types and nullability", async () => {
    const db = await rows<{ table: string; column: string; type: string; notnull: boolean }>(sql`
      select c.relname as "table", a.attname as "column",
             format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and a.attnum > 0 and not a.attisdropped and c.relname <> 'schema_migrations'`);
    const actual = db.map((r) => `${r.table}.${r.column} ${r.type}${r.notnull ? " not null" : ""}`).sort();
    const declared = tables
      .flatMap((t) =>
        t.columns.map((c) => `${t.name}.${c.name} ${normalizeType(c.getSQLType())}${c.notNull ? " not null" : ""}`),
      )
      .sort();
    expect(declared).toEqual(actual);
  });

  it("declares the same primary keys", async () => {
    const db = await rows<{ table: string; columns: string[] }>(sql`
      select c.relname as "table", array_agg(a.attname::text order by a.attname) as columns
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
      where k.contype = 'p' and c.relnamespace = 'public'::regnamespace and c.relname <> 'schema_migrations'
      group by c.relname, k.oid`);
    const actual = db.map((r) => `${r.table}(${key(r.columns)})`).sort();
    const declared = tables
      .flatMap((t) => [
        ...t.columns.filter((c) => c.primary).map((c) => `${t.name}(${c.name})`),
        ...t.primaryKeys.map((pk) => `${t.name}(${key(pk.columns.map((c) => c.name))})`),
      ])
      .sort();
    expect(declared).toEqual(actual);
  });

  it("declares the same foreign keys", async () => {
    const db = await rows<{ table: string; columns: string[]; ref: string; refColumns: string[]; ondelete: string }>(sql`
      select c.relname as "table", r.relname as ref, k.confdeltype::text as ondelete,
             (select array_agg(a.attname::text order by u.n) from unnest(k.conkey) with ordinality u(attnum, n)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) as columns,
             (select array_agg(a.attname::text order by u.n) from unnest(k.confkey) with ordinality u(attnum, n)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum) as "refColumns"
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_class r on r.oid = k.confrelid
      where k.contype = 'f' and c.relnamespace = 'public'::regnamespace`);
    const actions: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
    const actual = db
      .map((r) => `${r.table}(${r.columns.join(",")}) -> ${r.ref}(${r.refColumns.join(",")}) on delete ${actions[r.ondelete]}`)
      .sort();
    const declared = tables
      .flatMap((t) =>
        t.foreignKeys.map((fk) => {
          const ref = fk.reference();
          return `${t.name}(${ref.columns.map((c) => c.name).join(",")}) -> ${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns
            .map((c) => c.name)
            .join(",")}) on delete ${fk.onDelete ?? "no action"}`;
        }),
      )
      .sort();
    expect(declared).toEqual(actual);
  });

  it("declares the same unique constraints and unique indexes", async () => {
    // Unique constraints are backed by unique indexes, so both are read from pg_index.
    const db = await rows<{ table: string; columns: string[] | null; partial: boolean }>(sql`
      select c.relname as "table", i.indpred is not null as partial,
             (select array_agg(a.attname::text order by a.attname) from unnest(i.indkey) u(attnum)
                join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum) as columns
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      where i.indisunique and not i.indisprimary
        and c.relnamespace = 'public'::regnamespace and c.relname <> 'schema_migrations'`);
    const actual = db.map((r) => `${r.table}(${key(r.columns ?? [])})${r.partial ? " where" : ""}`).sort();
    const declared = tables
      .flatMap((t) => [
        ...t.columns.filter((c) => c.isUnique).map((c) => `${t.name}(${c.name})`),
        ...t.uniqueConstraints.map((u) => `${t.name}(${key(u.columns.map((c) => c.name))})`),
        ...t.indexes
          .filter((i) => i.config.unique)
          .map(
            (i) =>
              `${t.name}(${key(i.config.columns.map((c) => ("name" in c && typeof c.name === "string" ? c.name : "")).filter(Boolean))})${
                i.config.where ? " where" : ""
              }`,
          ),
      ])
      .sort();
    expect(declared).toEqual(actual);
  });

  it("declares the same check constraints and indexes by name", async () => {
    const db = await rows<{ name: string }>(sql`
      select 'check ' || c.relname || '.' || k.conname as name
      from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and c.relnamespace = 'public'::regnamespace
      union all
      select 'index ' || c.relname || '.' || ic.relname
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
      where not i.indisprimary and c.relnamespace = 'public'::regnamespace and c.relname <> 'schema_migrations'
        and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype = 'u')`);
    const declared = tables
      .flatMap((t) => [
        ...t.checks.map((c) => `check ${t.name}.${c.name}`),
        ...t.indexes.map((i) => `index ${t.name}.${i.config.name}`),
      ])
      .sort();
    expect(declared).toEqual(db.map((r) => r.name).sort());
  });
});
