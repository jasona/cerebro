import { createDatabase } from "../client";
import { migrate } from "../migrate";
import { runBriefingSeedHook, seedOrganizations } from "../seed";

const handle = await createDatabase();
try {
  await migrate(handle);
  const result = await seedOrganizations(handle.db);
  const hook = await runBriefingSeedHook(handle, result);
  console.log(`Seeded ${Object.keys(result.users).length} users, companies acme and globex (${handle.kind}).`);
  console.log(hook === "ran" ? "Briefing fixtures seeded." : "Briefing fixtures skipped: packages/domain/src/seed/briefings.ts not found.");
} finally {
  await handle.close();
}
