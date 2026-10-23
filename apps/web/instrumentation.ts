/**
 * Server start hook. Under PGlite only one process may open the data
 * directory, so the web process runs background jobs (indexing, extraction,
 * topic summaries) itself; with DATABASE_URL run `npm run worker` instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDatabase, runJobsInProcess } = await import("@cerebro/database");
  const { assertSourceStoreConfig, startInProcessJobRunner } = await import("@cerebro/domain");
  // Fail fast on a misconfigured object store (CEREBRO_OBJECT_STORE=s3 without its settings).
  assertSourceStoreConfig();
  const handle = await getDatabase();
  if (runJobsInProcess(handle)) startInProcessJobRunner(handle.db, { intervalMs: 1000 });
}
