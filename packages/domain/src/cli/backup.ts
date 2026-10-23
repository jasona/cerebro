/**
 * `npm run db:backup [-- --out <dir>] [--no-prune]`: back up the database
 * (PGlite data dir, or Postgres via pg_dump) and the source objects into a
 * new directory (default `<CEREBRO_BACKUP_DIR or .data/backups>/<timestamp>`).
 *
 * - Objects: the local store directory, or with `CEREBRO_OBJECT_STORE=s3`
 *   every object under the bucket prefix, streamed and sha256-verified.
 * - Pruning (D26): afterwards, keep the newest `CEREBRO_BACKUP_KEEP` complete
 *   backups (default 14; `off` disables) in the backup root. Only directories
 *   with a Cerebro manifest are ever deleted. Skipped with `--out`.
 * - Off-site (D26): when `CEREBRO_BACKUP_S3_*` is configured, upload the
 *   finished backup to that bucket (`ops/backup-offsite.ts`); otherwise say
 *   that no off-site copy was made.
 *
 * Under PGlite, stop `npm run dev` first: only one process may open the data
 * directory. Prints paths and counts only, never credentials.
 */
import { backupDatabase, backupKeepFromEnv, defaultBackupRoot, pruneBackups } from "@cerebro/database/backup";
import { offsiteConfigFromEnv, uploadBackupOffsite } from "../ops/backup-offsite";
import { backupObjectStoreFromEnv } from "../sources/backup-objects";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
const noPrune = args.includes("--no-prune");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

let failed = false;
try {
  // Validate every setting before writing anything.
  const objectStore = backupObjectStoreFromEnv();
  const offsite = offsiteConfigFromEnv();
  const keep = backupKeepFromEnv();

  const { dir, manifest } = await backupDatabase({ ...(objectStore ? { objectStore } : {}) }, out);
  const missing = manifest.objects.missing ? `, ${manifest.objects.missing} deleted during the backup` : "";
  console.log(
    `Backup written to ${dir} (${manifest.database.kind}, ${manifest.migrations.length} migrations, ${manifest.objects.files} objects from the ${manifest.objects.store ?? "local"} store${missing}).`,
  );
  if (objectStore?.skipped) console.log(`Skipped ${objectStore.skipped} bucket keys under the prefix that are not source objects.`);

  if (offsite) {
    try {
      const res = await uploadBackupOffsite(dir, offsite);
      console.log(`Off-site copy: ${res.files} files (${res.bytes} bytes) to bucket ${res.bucket} under ${res.prefix}`);
    } catch (err) {
      failed = true;
      console.error(`Off-site copy failed: ${message(err)}`);
    }
  } else {
    console.log("No off-site copy made: CEREBRO_BACKUP_S3_ENDPOINT and CEREBRO_BACKUP_S3_BUCKET are not set.");
  }

  if (noPrune || out) console.log("Pruning skipped.");
  else if (keep === null) console.log("Pruning off (CEREBRO_BACKUP_KEEP=off).");
  else {
    const deleted = await pruneBackups(defaultBackupRoot(), keep);
    console.log(`Kept the newest ${keep} backups; deleted ${deleted.length}${deleted.length ? `: ${deleted.join(", ")}` : ""}.`);
  }
} catch (err) {
  failed = true;
  console.error(`Backup failed: ${message(err)}`);
}
if (failed) process.exit(1);
