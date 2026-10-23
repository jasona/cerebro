import { createDatabase, type DatabaseHandle } from "./client";
import { migrate } from "./migrate";

let template: Promise<Blob> | undefined;

async function migratedTemplate(): Promise<Blob> {
  const handle = await createDatabase({ memory: true, url: "" });
  try {
    await migrate(handle);
    const { PGlite } = await import("@electric-sql/pglite");
    return await (handle.raw as InstanceType<typeof PGlite>).dumpDataDir("none");
  } finally {
    await handle.close();
  }
}

/**
 * A fresh, migrated, in-memory PGlite database. The first call per process
 * migrates once and caches a data-dir dump; later calls restore from it.
 * Always PGlite, even when DATABASE_URL is set.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  template ??= migratedTemplate().catch((err: unknown) => {
    template = undefined;
    throw err;
  });
  return createDatabase({ memory: true, url: "", loadDataDir: await template });
}
