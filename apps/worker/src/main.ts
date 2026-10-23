/**
 * Background worker: index_revision, embed_revision, extract_source, summarize_topics.
 *
 * Runs only against PostgreSQL (DATABASE_URL). Under PGlite the web process
 * runs jobs in-process (`startInProcessJobRunner`), because PGlite permits one
 * process per data directory.
 */
import { createDatabase } from "@cerebro/database";
import { loadAiRuntime } from "@cerebro/domain";
import { assertWorkerDatabaseUrl, jsonLogger, PGLITE_REFUSAL, runWorkerLoop } from "./worker";

async function main(): Promise<number> {
  let url: string;
  try {
    url = assertWorkerDatabaseUrl();
  } catch {
    jsonLogger("error", "worker.refused", { reason: "pglite_not_supported", detail: PGLITE_REFUSAL });
    return 1;
  }
  // Fail fast on AI misconfiguration (e.g. CEREBRO_AI_PROVIDER=ai-sdk without
  // the named module installed). The message names settings, never secrets.
  try {
    const rt = await loadAiRuntime();
    jsonLogger("info", "worker.ai", {
      embeddings: rt.embeddings ? `${rt.embeddings.id}:${rt.embeddings.model}` : null,
      retrievalMode: rt.retrievalMode,
    });
  } catch (err) {
    jsonLogger("error", "worker.refused", { reason: "ai_config", detail: err instanceof Error ? err.message : "invalid AI configuration" });
    return 1;
  }
  const handle = await createDatabase({ url });
  if (handle.kind !== "postgres") {
    await handle.close();
    jsonLogger("error", "worker.refused", { reason: "pglite_not_supported", detail: PGLITE_REFUSAL });
    return 1;
  }

  const controller = new AbortController();
  const stop = (signal: string) => {
    if (controller.signal.aborted) return;
    jsonLogger("info", "worker.stopping", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
  try {
    await runWorkerLoop(handle.db, { signal: controller.signal, intervalMs: Number.isFinite(intervalMs) ? intervalMs : 1_000 });
  } finally {
    await handle.close();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    jsonLogger("error", "worker.crashed", { errorName: err instanceof Error ? err.name : "unknown" });
    process.exit(1);
  },
);
