/**
 * `npm run db:restore -- <backup dir> --yes`: restore a backup made by
 * `npm run db:backup`. `npm run db:restore -- <backup dir> --check` only
 * verifies it (manifest, database file size, every object's sha256) and
 * changes nothing.
 *
 * The backup is always verified first. Under PGlite the current data
 * directory and object directory are moved aside (never deleted); under
 * Postgres the target database's contents are replaced (`pg_restore
 * --clean`). With `CEREBRO_OBJECT_STORE=s3`, objects are written back to the
 * bucket with the store's immutable put; objects already there are kept.
 * Stop the app first.
 */
import { restoreDatabase, verifyBackup } from "@cerebro/database/backup";
import { backupObjectStoreFromEnv } from "../sources/backup-objects";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const checkOnly = args.includes("--check");
if (!dir || (!checkOnly && !args.includes("--yes"))) {
  console.error("Usage: npm run db:restore -- <backup dir> --yes    (or --check to verify only)");
  console.error("Restoring replaces the current database and restores the source objects (PGlite data is moved aside, not deleted).");
  process.exit(1);
}

try {
  const verified = await verifyBackup(dir);
  console.log(`Backup verified: ${verified.manifest.database.kind}, ${verified.manifest.migrations.length} migrations, ${verified.files} objects (${verified.bytes} bytes), sha256 checked.`);
  if (checkOnly) process.exit(0);
} catch (err) {
  console.error(`Backup check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && process.env.CEREBRO_ALLOW_PRODUCTION_RESTORE !== "1") {
  console.error("db:restore refuses to run with NODE_ENV=production unless CEREBRO_ALLOW_PRODUCTION_RESTORE=1");
  process.exit(1);
}

try {
  const objectStore = backupObjectStoreFromEnv();
  const res = await restoreDatabase(dir, { ...(objectStore ? { objectStore } : {}) });
  console.log(`Restored ${res.manifest.database.kind} backup from ${res.manifest.createdAt}.`);
  if (objectStore) console.log(`Wrote back ${res.objectsRestored} objects to the S3 store (existing objects kept).`);
  if (res.movedAside.dataDir) console.log(`Previous PGlite data moved to ${res.movedAside.dataDir}`);
  if (res.movedAside.objectsDir) console.log(`Previous objects moved to ${res.movedAside.objectsDir}`);
} catch (err) {
  console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
