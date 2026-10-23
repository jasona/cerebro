/**
 * @cerebro/database — schema, migrations, client factory, auth contexts, jobs, seed.
 *
 * Transaction gotchas:
 * - Inside withAuthContext/withSystemContext callbacks, use only the `tx`
 *   argument. On PGlite, using the outer `db` inside a transaction waits for
 *   the transaction to finish and deadlocks; on Postgres it silently runs
 *   outside the auth context on another pooled connection.
 * - PGlite is single-connection: transactions are serialized by PGlite's own
 *   mutex. Long transactions block every other request in the process.
 * - `count(*)` comes back as a number on PGlite and a string on node-postgres;
 *   cast in SQL (`count(*)::int`) for portable results.
 */
export * from "./schema";
export * from "./client";
export { migrate, loadMigrations, migrationsDir, type MigrationFile } from "./migrate";
export * from "./jobs";
export {
  seed,
  seedOrganizations,
  runBriefingSeedHook,
  devAuthSubject,
  type SeedResult,
  type SeedOrg,
  type SeedUserKey,
  type SeedBriefings,
} from "./seed";
export { createTestDatabase } from "./testing";
