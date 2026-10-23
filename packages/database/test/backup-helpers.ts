/** Shared by the PGlite backup test and the Postgres server tests. */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { backupDatabase, readBackupManifest, restoreDatabase, type RestoreResult } from "../src/backup";
import { migrate, seedOrganizations, users, type DatabaseHandle } from "../src/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

async function writeObject(objectsDir: string, name: string, text: string) {
  await mkdir(join(objectsDir, ORG), { recursive: true });
  await writeFile(join(objectsDir, ORG, name), text);
}

async function userNames(h: DatabaseHandle): Promise<string[]> {
  const rows = await h.db.select({ name: users.displayName }).from(users).orderBy(users.displayName);
  return rows.map((r) => r.name);
}

export interface RoundTripTarget {
  url?: string;
  dataDir?: string;
  objectsDir: string;
  pgBinDir?: string;
}

/** Seed → back up → mutate database and objects → restore → verify everything is as backed up. */
export async function backupRoundTrip(open: () => Promise<DatabaseHandle>, target: RoundTripTarget, backupDir: string): Promise<RestoreResult> {
  let h = await open();
  await migrate(h);
  await seedOrganizations(h.db);
  const before = await userNames(h);
  expect(before).toContain("Maya Chen");
  await h.close();
  await writeObject(target.objectsDir, KEY_A, "original bytes");

  const { dir, manifest } = await backupDatabase(target, backupDir);
  expect(manifest.objects).toEqual({ files: 1, bytes: "original bytes".length });
  expect(manifest.migrations).toContain("0009_retention");
  expect(await readBackupManifest(dir)).toEqual(manifest);
  expect(await readFile(join(dir, "manifest.json"), "utf8")).not.toContain("Maya");

  h = await open();
  await h.db.update(users).set({ displayName: "Mutated" }).where(eq(users.displayName, "Maya Chen"));
  await h.db.execute(sql`insert into schema_migrations (id, checksum) values ('9999_bogus', 'x')`);
  expect(await userNames(h)).toContain("Mutated");
  await h.close();
  await rm(join(target.objectsDir, ORG, KEY_A));
  await writeObject(target.objectsDir, KEY_B, "later bytes");

  const res = await restoreDatabase(dir, target);
  expect(res.manifest).toEqual(manifest);
  h = await open();
  try {
    expect(await userNames(h)).toEqual(before);
    const bogus = await h.db.execute<{ id: string }>(sql`select id from schema_migrations where id = '9999_bogus'`);
    expect(bogus.rows).toEqual([]);
    // RLS and the runtime role's tables survive the round trip; nothing left to migrate.
    const rls = await h.db.execute<{ relforcerowsecurity: boolean }>(sql`select relforcerowsecurity from pg_class where relname = 'rate_limit_counters'`);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);
    expect(await migrate(h)).toEqual([]);
  } finally {
    await h.close();
  }
  expect(await readdir(join(target.objectsDir, ORG))).toEqual([KEY_A]);
  expect(await readFile(join(target.objectsDir, ORG, KEY_A), "utf8")).toBe("original bytes");
  if (res.movedAside.objectsDir) expect(await readdir(join(res.movedAside.objectsDir, ORG))).toEqual([KEY_B]);
  return res;
}
