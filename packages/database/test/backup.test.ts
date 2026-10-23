/**
 * Backup → mutate → restore → verify for PGlite. The Postgres variant
 * (pg_dump/pg_restore) runs in packages/domain/test/postgres.test.ts when
 * Postgres binaries are available.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, restoreDatabase } from "../src/backup";
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
