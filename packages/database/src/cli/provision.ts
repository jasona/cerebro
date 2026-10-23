/**
 * `npm run db:provision`: prepare a PostgreSQL server for Cerebro with
 * superuser credentials, so that `npm run db:migrate` can run as the owner role.
 *
 * Requires `DATABASE_ADMIN_URL` (a superuser URL on the same server) and
 * `DATABASE_URL` (owner role, password and database). Creates or updates the
 * owner role (LOGIN CREATEROLE BYPASSRLS), creates the database owned by it
 * if missing, and creates the `vector` extension. Idempotent; see
 * provision.ts. Prints role and database names only, never passwords.
 */
import { provisionDatabase } from "../provision";

const adminUrl = process.env.DATABASE_ADMIN_URL?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!adminUrl || !databaseUrl) {
  console.error("db:provision needs DATABASE_ADMIN_URL (superuser) and DATABASE_URL (owner role and database).");
  process.exit(1);
}

try {
  const r = await provisionDatabase({ adminUrl, databaseUrl });
  console.log(
    `Provisioned database ${r.database} (${r.databaseAction}) owned by ${r.role} (role ${r.roleAction}); vector extension ${r.extension}.`,
  );
} catch (err) {
  console.error(`Provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
