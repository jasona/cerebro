/**
 * `npm run db:restore -- <backup dir> --yes`: restore a backup made by
 * `npm run db:backup`. Under PGlite the current data directory and object
 * directory are moved aside (never deleted); under Postgres the target
 * database's objects are replaced (`pg_restore --clean`). Stop the app first.
 */
import { restoreDatabase } from "../backup";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir || !args.includes("--yes")) {
  console.error("Usage: npm run db:restore -- <backup dir> --yes");
  console.error("Restoring replaces the current database and object store (PGlite data is moved aside, not deleted).");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.CEREBRO_ALLOW_PRODUCTION_RESTORE !== "1") {
  console.error("db:restore refuses to run with NODE_ENV=production unless CEREBRO_ALLOW_PRODUCTION_RESTORE=1");
  process.exit(1);
}

try {
  const res = await restoreDatabase(dir);
  console.log(`Restored ${res.manifest.database.kind} backup from ${res.manifest.createdAt}.`);
  if (res.movedAside.dataDir) console.log(`Previous PGlite data moved to ${res.movedAside.dataDir}`);
  if (res.movedAside.objectsDir) console.log(`Previous objects moved to ${res.movedAside.objectsDir}`);
} catch (err) {
  console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
