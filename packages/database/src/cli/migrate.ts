import { createDatabase } from "../client";
import { migrate } from "../migrate";

const handle = await createDatabase();
try {
  const applied = await migrate(handle);
  console.log(applied.length ? `Applied ${applied.join(", ")} (${handle.kind})` : `Database is up to date (${handle.kind})`);
} finally {
  await handle.close();
}
