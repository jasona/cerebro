/**
 * Server start hook. Loads the AI runtime from the environment first, so a
 * misconfigured provider (for example `CEREBRO_AI_PROVIDER=ai-sdk` without
 * the named module installed) stops start-up with a clear message instead of
 * failing later. Under PGlite only one process may open the data directory,
 * so the web process runs background jobs (indexing, embedding, extraction,
 * topic summaries) itself; with DATABASE_URL run `npm run worker` instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDatabase, runJobsInProcess } = await import("@cerebro/database");
  const { loadAiRuntime, startInProcessJobRunner } = await import("@cerebro/domain");
  await loadAiRuntime();
  const handle = await getDatabase();
  if (runJobsInProcess(handle)) startInProcessJobRunner(handle.db, { intervalMs: 1000 });
}
