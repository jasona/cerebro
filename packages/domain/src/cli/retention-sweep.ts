/**
 * `npm run retention:sweep`: apply every organization's retention policy
 * once. With no policy set (the default; P11 is undecided) this deletes
 * nothing. Under PGlite, stop `npm run dev` first. Prints counts only.
 */
import { createDatabase, migrate } from "@cerebro/database";
import { runRetentionSweepOnce } from "../ops/retention";

const handle = await createDatabase();
try {
  if (handle.kind === "pglite") await migrate(handle);
  const results = await runRetentionSweepOnce(handle.db);
  if (!results.length) console.log("No organization has a retention period set; nothing was deleted.");
  for (const r of results) console.log(JSON.stringify(r));
} finally {
  await handle.close();
}
