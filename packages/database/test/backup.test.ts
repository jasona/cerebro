/**
 * Backup → mutate → restore → verify for PGlite. The Postgres variant
 * (pg_dump/pg_restore) runs in packages/domain/test/postgres.test.ts when
 * Postgres binaries are available.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, pgConnectionForTool, restoreDatabase, runPgTool } from "../src/backup";
import { createDatabase, migrate } from "../src/index";
import { backupRoundTrip } from "./backup-helpers";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cerebro-backup-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("backup and restore (PGlite)", () => {
  it("round-trips the data directory and the object store", async () => {
    const dataDir = join(root, "pglite", "data");
    const objectsDir = join(root, "pglite", "objects");
    const res = await backupRoundTrip(() => createDatabase({ url: "", dataDir }), { url: "", dataDir, objectsDir }, join(root, "backup-1"));
    // The pre-restore data directory is kept, not deleted.
    expect(res.movedAside.dataDir && existsSync(res.movedAside.dataDir)).toBe(true);
  });

  it("refuses to restore a backup of another database kind, or into a non-empty backup directory", async () => {
    const dataDir = join(root, "kind", "data");
    const objectsDir = join(root, "kind", "objects");
    const h = await createDatabase({ url: "", dataDir });
    await migrate(h);
    await h.close();
    const { dir } = await backupDatabase({ url: "", dataDir, objectsDir }, join(root, "kind-backup"));
    await expect(restoreDatabase(dir, { url: "postgres://127.0.0.1:1/none", objectsDir })).rejects.toThrow(/pglite/);
    await expect(backupDatabase({ url: "", dataDir, objectsDir }, dir)).rejects.toThrow(/not empty/);
  });
});

describe("backup file safety", () => {
  it("makes the backup directory private even when it already existed", async () => {
    const dataDir = join(root, "perm", "data");
    const objectsDir = join(root, "perm", "objects");
    const h = await createDatabase({ url: "", dataDir });
    await migrate(h);
    await h.close();
    const out = join(root, "perm-backup");
    await mkdir(out, { mode: 0o755 });
    await chmod(out, 0o755);
    const { dir, manifest } = await backupDatabase({ url: "", dataDir, objectsDir }, out);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, manifest.database.file))).mode & 0o077).toBe(0);
    expect((await stat(join(dir, "manifest.json"))).mode & 0o077).toBe(0);
  });

  it("refuses a manifest that names a database file outside the backup", async () => {
    const dataDir = join(root, "trav", "data");
    const objectsDir = join(root, "trav", "objects");
    const h = await createDatabase({ url: "", dataDir });
    await migrate(h);
    await h.close();
    const { dir, manifest } = await backupDatabase({ url: "", dataDir, objectsDir }, join(root, "trav-backup"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, database: { ...manifest.database, file: "../../outside.tar.gz" } }));
    await expect(restoreDatabase(dir, { url: "", dataDir, objectsDir })).rejects.toThrow(/database file/);
    // Nothing was moved aside: the refusal happens before the target is touched.
    expect(existsSync(dataDir)).toBe(true);
  });
});

describe("Postgres tool invocation", () => {
  const URL_WITH_SECRET = "postgres://cerebro:s3cr%40t-pw@db.internal:5432/cerebro?sslmode=require";

  it("keeps the password out of the command line", () => {
    const { dbname, env } = pgConnectionForTool(URL_WITH_SECRET);
    expect(dbname).not.toContain("s3cr");
    expect(dbname).toBe("postgres://cerebro@db.internal:5432/cerebro?sslmode=require");
    expect(env.PGPASSWORD).toBe("s3cr@t-pw");
    const q = pgConnectionForTool("postgresql://u@h/db?password=qsecret&sslmode=require");
    expect(q.dbname).not.toContain("qsecret");
    expect(q.env.PGPASSWORD).toBe("qsecret");
    expect(pgConnectionForTool("postgres://u@h/db").env).toEqual({});
  });

  it("never puts the password in argv or in a failure message", async () => {
    const bin = join(root, "fake-bin");
    const seen = join(root, "fake-argv.txt");
    await rm(bin, { recursive: true, force: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "pg_dump"), `#!/bin/sh\necho "$@" > "${seen}"\necho "pg_dump: error: connection failed" >&2\nexit 1\n`);
    await chmod(join(bin, "pg_dump"), 0o755);
    const err = await runPgTool(bin, "pg_dump", URL_WITH_SECRET, ["--format=custom"]).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("pg_dump");
    expect(err!.message).not.toContain("s3cr");
    expect(await readFile(seen, "utf8")).not.toContain("s3cr");
  });
});
