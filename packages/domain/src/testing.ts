import { randomUUID } from "node:crypto";
import { createTestDatabase, seedOrganizations, type DatabaseHandle, type SeedResult, type SeedUserKey } from "@cerebro/database";
import type { RequestContext } from "./context";

export interface TestWorld {
  h: DatabaseHandle;
  seed: SeedResult;
  /** Context for a seeded user in Acme (default) or Globex. */
  ctx(user: SeedUserKey, org?: "acme" | "globex", via?: RequestContext["via"]): RequestContext;
}

/** Fresh migrated in-memory database with seeded organizations and users (no briefings). */
export async function createTestWorld(): Promise<TestWorld> {
  const h = await createTestDatabase();
  const seed = await seedOrganizations(h.db);
  return {
    h,
    seed,
    ctx: (user, org = "acme", via = "web") => ({
      userId: seed.users[user],
      organizationId: seed.orgs[org].id,
      via,
      requestId: randomUUID(),
    }),
  };
}
