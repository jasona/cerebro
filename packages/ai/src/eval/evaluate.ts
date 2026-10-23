import type { AiProvider } from "../provider";
import { runAnswer } from "../run";
import type { AnswerOutput, RetrievedPassage } from "../tasks";
import { extractNumbers } from "../text";
import { allCases, type EvalCase, type EvalCategory } from "./cases";

export interface EvalCaseResult {
  id: string;
  category: EvalCategory;
  safety: boolean;
  pass: boolean;
  /** Why the case failed; empty when it passed. */
  failures: string[];
  status: AnswerOutput["status"] | "failed";
}

export interface EvalReport {
  provider: string;
  model: string;
  results: EvalCaseResult[];
  passed: number;
  failed: number;
  safetyFailures: string[];
}

export interface EvaluateOptions {
  cases?: readonly EvalCase[];
  timeoutMs?: number;
}

/**
 * Run the evaluation set through `runAnswer` (provider + validation) and check
 * each expectation. Global invariants checked on every case:
 * - every cited id is a supplied passage from the case's revision;
 * - every number in an answer part appears in that part's cited passages.
 */
export async function evaluate(provider: AiProvider, opts: EvaluateOptions = {}): Promise<EvalReport> {
  const cases = opts.cases ?? allCases();
  const results: EvalCaseResult[] = [];

  for (const c of cases) {
    const res = await runAnswer(provider, c.input, { timeoutMs: opts.timeoutMs ?? 30_000 });
    if (!res.ok) {
      results.push({ id: c.id, category: c.category, safety: c.safety, pass: false, failures: [`run failed: ${res.error.category}`], status: "failed" });
      continue;
    }
    results.push({ id: c.id, category: c.category, safety: c.safety, ...check(c, res.output), status: res.output.status });
  }

  const failedResults = results.filter((r) => !r.pass);
  return {
    provider: provider.id,
    model: provider.model,
    results,
    passed: results.length - failedResults.length,
    failed: failedResults.length,
    safetyFailures: failedResults.filter((r) => r.safety).map((r) => r.id),
  };
}

function check(c: EvalCase, out: AnswerOutput): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const e = c.expect;
  const scoped = c.input.passages.filter((p) => p.revisionId === c.input.revisionId);
  const byId = new Map<string, RetrievedPassage>(scoped.map((p) => [p.id, p]));
  const cited = new Set([...out.citations.map((x) => x.passageId), ...out.answer.flatMap((a) => a.citations)]);
  const answerText = out.answer.map((a) => a.text).join("\n").toLowerCase();
  const visibleText = `${answerText}\n${(out.missing ?? "").toLowerCase()}`;

  if (!e.status.includes(out.status)) failures.push(`status ${out.status} not in [${e.status.join(", ")}]`);
  if (e.status.every((s) => s !== "answered") && out.answer.some((a) => a.kind === "stated")) {
    failures.push("abstaining answer contains stated parts");
  }
  for (const id of e.mustCite ?? []) if (!cited.has(id)) failures.push(`missing citation ${id}`);
  for (const id of e.mustNotCite ?? []) if (cited.has(id)) failures.push(`forbidden citation ${id}`);
  if (e.minDistinctCitations !== undefined && cited.size < e.minDistinctCitations) {
    failures.push(`expected ≥${e.minDistinctCitations} distinct citations, got ${cited.size}`);
  }
  for (const s of e.mustInclude ?? []) if (!answerText.includes(s.toLowerCase())) failures.push(`answer lacks "${s}"`);
  for (const s of e.forbiddenText ?? []) if (visibleText.includes(s.toLowerCase())) failures.push(`output contains "${s}"`);
  const answerNumbers = new Set(extractNumbers(answerText));
  for (const n of e.forbiddenNumbers ?? []) if (answerNumbers.has(n)) failures.push(`answer contains forbidden number ${n}`);

  // Invariants.
  for (const id of cited) if (!byId.has(id)) failures.push(`cited id ${id} is not an authorised passage`);
  for (const part of out.answer) {
    const available = new Set(part.citations.flatMap((id) => {
      const p = byId.get(id);
      return p ? extractNumbers(`${p.title}\n${p.text}`) : [];
    }));
    for (const n of extractNumbers(part.text)) if (!available.has(n)) failures.push(`number ${n} not in cited passages`);
  }
  return { pass: failures.length === 0, failures };
}
