/**
 * `npm run ai:eval` — run the evaluation sets against the configured AI
 * providers (W2.4) and compare full-text with hybrid retrieval (W3.2).
 *
 * - Answer set: `packages/ai` evaluation cases through `runAnswer` for every
 *   configured provider (the configured model provider, if any, and the local
 *   deterministic provider).
 * - Retrieval set: labelled questions on the fictional strategy briefing,
 *   indexed and embedded through the real jobs on in-memory PGlite, ranked by
 *   full-text and by hybrid fusion. Uses the configured embedding provider,
 *   or the local hashed embeddings when none is configured.
 *
 * Writes `.data/ai-eval/ai-eval-<timestamp>.{json,md}` (git-ignored; the
 * report may quote the fictional fixtures) and prints metrics only: no
 * prompts, questions, passages or answers reach the console. No pass
 * threshold is applied; thresholds are for the user to set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { allCases, createAiFromEnv, describeAiSetup, evaluate, type EvalReport } from "@cerebro/ai";
import { evaluateRetrieval, type RankMetrics, type RetrievalEvalReport } from "../packages/domain/src/quality/retrieval-benchmark";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = join(repoRoot, ".data", "ai-eval");

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function categorySummary(r: EvalReport): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const c of r.results) {
    const s = (out[c.category] ??= { passed: 0, total: 0 });
    s.total++;
    if (c.pass) s.passed++;
  }
  return out;
}

function metricsRow(name: string, m: RankMetrics): string {
  return `| ${name} | ${m.queries} | ${m.hitAt1.toFixed(3)} | ${m.recallAt3.toFixed(3)} | ${m.recallAt5.toFixed(3)} | ${m.mrr.toFixed(3)} |`;
}

function markdown(started: Date, setup: Record<string, string | number | null>, answers: (EvalReport & { durationMs: number })[], retrieval: RetrievalEvalReport | { error: string }): string {
  const lines: string[] = [
    "# Cerebro AI evaluation",
    "",
    `Run: ${started.toISOString()}`,
    "",
    "No pass threshold is applied. All fixture content is fictional.",
    "",
    "## Configuration",
    "",
    ...Object.entries(setup).map(([k, v]) => `- ${k}: ${v ?? "none"}`),
    "",
    "## Answer evaluation",
    "",
    "| Provider | Model | Cases | Passed | Failed | Safety failures | Duration |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...answers.map((a) => `| ${a.provider} | ${a.model} | ${a.results.length} | ${a.passed} | ${a.failed} | ${a.safetyFailures.length} | ${a.durationMs} ms |`),
    "",
  ];
  for (const a of answers) {
    lines.push(`### ${a.provider} by category`, "", "| Category | Passed | Total |", "| --- | --- | --- |");
    for (const [cat, s] of Object.entries(categorySummary(a))) lines.push(`| ${cat} | ${s.passed} | ${s.total} |`);
    const failing = a.results.filter((r) => !r.pass);
    lines.push("", failing.length ? "Failing cases:" : "No failing cases.", "");
    for (const f of failing) lines.push(`- \`${f.id}\` (${f.category}${f.safety ? ", safety" : ""}, status ${f.status}): ${f.failures.join("; ")}`);
    lines.push("");
  }
  lines.push("## Retrieval: full-text vs hybrid", "");
  if ("error" in retrieval) {
    lines.push(`Retrieval evaluation failed: ${retrieval.error}`);
  } else {
    lines.push(
      `Corpus: ${retrieval.corpus.name}, ${retrieval.corpus.chunks} chunks (${retrieval.corpus.embeddedChunks} embedded). ` +
        `Embedding: ${retrieval.embedding.provider} ${retrieval.embedding.model} (${retrieval.embedding.dimensions} dims, ${retrieval.embedding.source}). Ranked list length ${retrieval.topK}.`,
      "",
      "| Mode | Queries | Hit@1 | Recall@3 | Recall@5 | MRR |",
      "| --- | --- | --- | --- | --- | --- |",
      metricsRow("fts", retrieval.metrics.fts),
      metricsRow("hybrid", retrieval.metrics.hybrid),
      metricsRow("fts (lexical)", retrieval.metrics.fts.byKind.lexical),
      metricsRow("hybrid (lexical)", retrieval.metrics.hybrid.byKind.lexical),
      metricsRow("fts (paraphrase)", retrieval.metrics.fts.byKind.paraphrase),
      metricsRow("hybrid (paraphrase)", retrieval.metrics.hybrid.byKind.paraphrase),
      "",
      retrieval.embeddingFailures.length ? `Question embedding failed (full-text used) for: ${retrieval.embeddingFailures.join(", ")}` : "Every question was embedded.",
      "",
      "Reader Q&A passes up to the top 24 chunks to the answerer, so ranking changes what the model sees only when a revision has more chunks than that.",
      "",
      "### Per query (top 5)",
      "",
      "| Query | Kind | Relevant | fts | hybrid |",
      "| --- | --- | --- | --- | --- |",
      ...retrieval.perQuery.map((q) => `| ${q.id} | ${q.kind} | ${q.relevant.join(", ")} | ${q.fts.slice(0, 5).join(", ")} | ${q.hybrid.slice(0, 5).join(", ")} |`),
      "",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const started = new Date();
  let setup;
  try {
    setup = await createAiFromEnv(process.env);
  } catch (err) {
    console.error(`ai:eval: ${err instanceof Error ? err.message : "invalid AI configuration"}`);
    return 1;
  }
  const config = describeAiSetup(setup);
  console.log(`ai:eval providers=${config.providers} embeddings=${config.embeddings ?? "none"} cases=${allCases().length}`);

  const answers: (EvalReport & { durationMs: number })[] = [];
  for (const provider of setup.providers) {
    const t = performance.now();
    const report = await evaluate(provider);
    const durationMs = Math.round(performance.now() - t);
    answers.push({ ...report, durationMs });
    console.log(
      `answers provider=${report.provider} model=${report.model} passed=${report.passed}/${report.results.length} ` +
        `rate=${pct(report.passed / Math.max(1, report.results.length))} safetyFailures=${report.safetyFailures.length} durationMs=${durationMs}`,
    );
    for (const [cat, s] of Object.entries(categorySummary(report))) console.log(`  ${cat}: ${s.passed}/${s.total}`);
    const failing = report.results.filter((r) => !r.pass).map((r) => r.id);
    if (failing.length) console.log(`  failing case ids: ${failing.join(", ")}`);
  }

  let retrieval: RetrievalEvalReport | { error: string };
  try {
    retrieval = await evaluateRetrieval({ embeddings: setup.embeddings });
    console.log(
      `retrieval corpus chunks=${retrieval.corpus.chunks} embedded=${retrieval.corpus.embeddedChunks} ` +
        `embedding=${retrieval.embedding.provider}:${retrieval.embedding.model}:${retrieval.embedding.dimensions} (${retrieval.embedding.source}) queries=${retrieval.metrics.fts.queries}`,
    );
    for (const mode of ["fts", "hybrid"] as const) {
      const m = retrieval.metrics[mode];
      console.log(
        `  ${mode.padEnd(6)} hit@1=${m.hitAt1.toFixed(3)} recall@3=${m.recallAt3.toFixed(3)} recall@5=${m.recallAt5.toFixed(3)} mrr=${m.mrr.toFixed(3)} ` +
          `(lexical mrr=${m.byKind.lexical.mrr.toFixed(3)}, paraphrase mrr=${m.byKind.paraphrase.mrr.toFixed(3)})`,
      );
    }
    if (retrieval.embeddingFailures.length) console.log(`  question embedding failures: ${retrieval.embeddingFailures.length}`);
  } catch (err) {
    retrieval = { error: err instanceof Error ? err.name : "error" };
    console.log(`retrieval evaluation failed: ${retrieval.error}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `ai-eval-${stamp}`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ startedAt: started.toISOString(), configuration: config, answers, retrieval }, null, 2)}\n`);
  writeFileSync(`${base}.md`, markdown(started, config, answers, retrieval));
  console.log(`report: ${relative(repoRoot, base)}.json and .md (no threshold applied)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`ai:eval crashed: ${err instanceof Error ? err.name : "unknown"}`);
    process.exit(1);
  },
);
