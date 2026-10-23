/**
 * `npm run org:bootstrap -- --slug <slug> --name <company name> --owner-email <email> [--owner-name <name>]`
 *
 * Create a company and its first owner on a new deployment (see
 * org/bootstrap.ts). The owner then signs in (Clerk) with that verified
 * email, which claims the pre-provisioned user, and invites everyone else
 * from the app. Idempotent; refuses to touch an existing company unless the
 * named user is already its active owner. Every argument except
 * --owner-name is required: nothing is guessed. Prints ids only.
 */
import { createDatabase, migrate } from "@cerebro/database";
import { isDomainError } from "../errors";
import { bootstrapOrganization } from "../org/bootstrap";

const USAGE =
  'Usage: npm run org:bootstrap -- --slug <slug> --name "<company name>" --owner-email <email> [--owner-name "<display name>"]';

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const slug = arg("slug");
const name = arg("name");
const ownerEmail = arg("owner-email");
const ownerName = arg("owner-name");
if (!slug || !name || !ownerEmail) {
  console.error(USAGE);
  process.exit(1);
}

const handle = await createDatabase();
let code = 0;
try {
  if (handle.kind === "pglite") await migrate(handle);
  const r = await bootstrapOrganization(handle.db, { slug, name, ownerEmail, ...(ownerName ? { ownerName } : {}) });
  console.log(
    r.status === "created"
      ? `Created company ${r.slug} (${r.organizationId}) with owner ${r.userId} (${r.userCreated ? "new user" : "existing user"}). ` +
          "The owner can now sign in with that verified email."
      : `Company ${r.slug} (${r.organizationId}) already has this owner (${r.userId}); nothing changed.`,
  );
} catch (err) {
  if (isDomainError(err)) {
    const issues = (err.details?.issues as { path: string; message: string }[] | undefined) ?? [];
    console.error(`org:bootstrap refused: ${err.message}${issues.map((i) => ` ${i.path}: ${i.message}.`).join("")}`);
  } else {
    console.error(`org:bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
