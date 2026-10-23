/**
 * `npm run db:backup [-- --out <dir>]`: back up the database (PGlite data dir
 * or Postgres via pg_dump) and the private object store into a new directory
 * (default `.data/backups/<timestamp>`). Under PGlite, stop `npm run dev`
 * first: only one process may open the data directory.
 */
import { backupDatabase } from "../backup";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;

try {
  const { dir, manifest } = await backupDatabase({}, out);
  console.log(
    `Backup written to ${dir} (${manifest.database.kind}, ${manifest.migrations.length} migrations, ${manifest.objects.files} objects).`,
  );
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
