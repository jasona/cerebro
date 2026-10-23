/**
 * Operational checks against a real PostgreSQL server: backup/restore with
 * pg_dump/pg_restore, rate limits shared by separate connection pools (as
 * separate processes would be), and readiness. Runs only when Postgres
 * binaries with pgvector are available (`PG_BIN_DIR`, else PATH); starts a throwaway server
 * in a temp directory on CEREBRO_TEST_PG_PORT (default 55434).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate, seedOrganizations, type DatabaseHandle, type SeedResult } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupRoundTrip } from "../../database/test/backup-helpers";
import { DomainError } from "../src/errors";
import { checkReadiness } from "../src/ops/health";
import { enforceRateLimit } from "../src/ops/rate-limit";

const pgBin = process.env.PG_BIN_DIR;
const tool = (name: string) => (pgBin ? join(pgBin, name) : name);
const havePg = (() => {
  try {
    for (const t of ["initdb", "pg_ctl", "pg_dump", "pg_restore"]) execFileSync(tool(t), ["--version"], { stdio: "ignore" });
    // Migration 0001 needs pgvector in that installation.
    const share = execFileSync(tool("pg_config"), ["--sharedir"], { encoding: "utf8" }).trim();
    return existsSync(join(share, "extension", "vector.control"));
  } catch {
    return false;
  }
})();

const port = Number(process.env.CEREBRO_TEST_PG_PORT ?? 55434);
const urlFor = (db: string) => `postgres://postgres@127.0.0.1:${port}/${db}`;
let root: string;
let pgData: string;

async function createDb(name: string): Promise<string> {
  const admin = await createDatabase({ url: urlFor("postgres") });
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  return urlFor(name);
}

describe.skipIf(!havePg)("PostgreSQL server", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cerebro-pg-"));
    pgData = join(root, "data");
    await mkdir(root, { recursive: true });
    execFileSync(tool("initdb"), ["-D", pgData, "-U", "postgres", "--auth=trust", "--no-sync"], { stdio: "ignore" });
    execFileSync(tool("pg_ctl"), ["-D", pgData, "-o", `-p ${port} -k ${root} -c listen_addresses=127.0.0.1`, "-w", "-l", join(root, "log"), "start"], {
      stdio: "ignore",
    });
  });
  afterAll(async () => {
    try {
      execFileSync(tool("pg_ctl"), ["-D", pgData, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up and restores with pg_dump/pg_restore, objects included", async () => {
    const url = await createDb("cerebro_backup");
    await backupRoundTrip(() => createDatabase({ url }), { url, objectsDir: join(root, "objects"), ...(pgBin ? { pgBinDir: pgBin } : {}) }, join(root, "backup"));
  });

  describe("with a migrated database", () => {
    let a: DatabaseHandle;
    let b: DatabaseHandle;
    let seed: SeedResult;

    beforeAll(async () => {
      const url = await createDb("cerebro_ops");
      a = await createDatabase({ url });
      b = await createDatabase({ url });
      await migrate(a);
      seed = await seedOrganizations(a.db);
    });
    afterAll(async () => {
      await a?.close();
      await b?.close();
    });

    it("shares rate-limit counters across separate connection pools", async () => {
      const env = { RATE_LIMIT_QA_PER_USER: "2/3600" };
      const ctx = { userId: seed.users.alex, organizationId: seed.orgs.acme.id, via: "web" as const, requestId: "r" };
      await enforceRateLimit(a.db, ctx, "qa", { env });
      await enforceRateLimit(b.db, ctx, "qa", { env });
      const err = await enforceRateLimit(a.db, ctx, "qa", { env }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("rate_limited");
      // Concurrent calls from both pools never lose an increment.
      const env2 = { RATE_LIMIT_UPLOAD_PER_USER: "1000/3600" };
      await Promise.all(Array.from({ length: 20 }, (_, i) => enforceRateLimit(i % 2 ? a.db : b.db, ctx, "upload", { env: env2 })));
      const rows = await a.db.execute<{ count: number }>(sql`select count from rate_limit_counters where bucket = 'upload:user'`);
      expect(Number(rows.rows[0]!.count)).toBe(20);
    });

    it("reports ready with current migrations", async () => {
      const r = await checkReadiness(a.db, {});
      expect(r.ready).toBe(true);
      expect(r.checks.migrations.pending).toEqual([]);
    });
  });
});
