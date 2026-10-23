import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDatabase, defaultPgliteDir } from "../client";
import { migrate } from "../migrate";
import { runBriefingSeedHook, seedOrganizations } from "../seed";

// Destroys all local data. Stop `npm run dev` first when using PGlite: only one
// process may open the data directory.
if (process.env.NODE_ENV === "production") {
  console.error("db:reset refuses to run with NODE_ENV=production");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  const dir = defaultPgliteDir();
  rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}

const handle = await createDatabase();
try {
  if (handle.kind === "postgres") {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
    await handle.db.execute(sql`grant usage on schema public to public`);
    console.log("Dropped and recreated schema public");
  }
  await migrate(handle);
  const result = await seedOrganizations(handle.db);
  const hook = await runBriefingSeedHook(handle, result);
  console.log(`Reset complete (${handle.kind}); briefing fixtures ${hook === "ran" ? "seeded" : "skipped"}.`);
} finally {
  await handle.close();
}
