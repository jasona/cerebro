import { AiError, type AiErrorCategory } from "./errors";
import type { AiProvider, AiUsage } from "./provider";
import {
  AnswerInput,
  AnswerTask,
  type AiTask,
  type AiTaskName,
  type AnswerOutput,
  type AnswerStatus,
  type TaskInput,
  type TaskOutput,
} from "./tasks";
import { scopePassages, validateAnswer, type AnswerWarning, type SupportOptions } from "./validate-answer";

/**
 * Observability record for one AI run. Safe to persist and log: it holds ids,
 * labels, counts and categories only, never prompt, question, passage or
 * output text.
 */
export interface AiRunRecord {
  task: AiTaskName;
  provider: string;
  model: string;
  promptVersion: string;
  status: "succeeded" | "failed";
  latencyMs: number;
  usage: AiUsage;
  errorCategory: AiErrorCategory | null;
  /** Answer runs: the validated outcome. */
  outcome?: AnswerStatus;
  /** Answer runs: the authorised revision the answer is bound to. */
  revisionId?: string;
  /** Validation warning codes (no detail text). */
  warningCodes?: string[];
}

export interface RunTaskOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export type RunTaskResult<T> =
  | { ok: true; output: T; record: AiRunRecord }
  | { ok: false; error: { category: AiErrorCategory; message: string }; record: AiRunRecord };

/**
 * Run any task with timeout/abort handling and output-schema validation. A
 * provider that ignores its abort signal still yields a timely `failed` result.
 */
export async function runTask<T extends AiTask>(
  provider: AiProvider,
  task: T,
  input: TaskInput<T>,
  opts: RunTaskOptions,
): Promise<RunTaskResult<TaskOutput<T>>> {
  const started = performance.now();
  const record = (patch: Partial<AiRunRecord>): AiRunRecord => ({
    task: task.name,
    provider: provider.id,
    model: provider.model,
    promptVersion: task.promptVersion,
    status: "failed",
    latencyMs: Math.round(performance.now() - started),
    usage: {},
    errorCategory: null,
    ...patch,
  });
  const fail = (category: AiErrorCategory, message: string): RunTaskResult<TaskOutput<T>> => ({
    ok: false,
    error: { category, message },
    record: record({ status: "failed", errorCategory: category }),
  });

  const parsedInput = task.input.safeParse(input);
  if (!parsedInput.success) return fail("invalid_input", `invalid ${task.name} input`);
  if (!provider.supports(task.name)) return fail("unsupported", `${provider.id} does not support ${task.name}`);
  if (opts.signal?.aborted) return fail("aborted", "run aborted before start");

  const controller = new AbortController();
  let rejectStop: (e: AiError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const onAbort = () => {
    const e = new AiError("aborted", "run aborted");
    controller.abort(e);
    rejectStop(e);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const e = new AiError("timeout", `run exceeded ${opts.timeoutMs} ms`);
    controller.abort(e);
    rejectStop(e);
  }, opts.timeoutMs);

  try {
    const result = await Promise.race([
      provider.run(task, parsedInput.data as TaskInput<T>, { signal: controller.signal, timeoutMs: opts.timeoutMs }),
      stopped,
    ]);
    const output = task.output.safeParse(result.output);
    if (!output.success) return fail("invalid_output", `${task.name} output did not match its schema`);
    return {
      ok: true,
      output: output.data as TaskOutput<T>,
      record: record({
        status: "succeeded",
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        errorCategory: null,
      }),
    };
  } catch (err) {
    if (err instanceof AiError) return fail(err.category, err.message);
    return fail("provider_error", "provider failed");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    stopped.catch(() => {});
  }
}

export interface RunAnswerOptions extends RunTaskOptions {
  support?: SupportOptions;
}

export type RunAnswerResult =
  | { ok: true; output: AnswerOutput; warnings: AnswerWarning[]; record: AiRunRecord }
  | { ok: false; error: { category: AiErrorCategory; message: string }; warnings: AnswerWarning[]; record: AiRunRecord };

/**
 * Reader Q&A pipeline: scope passages to the authorised revision, run the
 * provider, then validate citations and support. The returned output is the
 * only thing that should be shown to a reader as a completed answer.
 *
 * The caller (domain layer) must already have authorised the reader and
 * retrieved `passages` from the published revision and its approved evidence.
 */
export async function runAnswer(provider: AiProvider, input: AnswerInput, opts: RunAnswerOptions): Promise<RunAnswerResult> {
  const parsed = AnswerInput.safeParse(input);
  if (!parsed.success) {
    const res = await runTask(provider, AnswerTask, input, opts);
    return { ...(res as Extract<RunTaskResult<AnswerOutput>, { ok: false }>), warnings: [] };
  }
  const scoped = scopePassages(parsed.data.passages, parsed.data.revisionId);
  const scopedInput: AnswerInput = { ...parsed.data, passages: scoped.passages };

  const res = await runTask(provider, AnswerTask, scopedInput, opts);
  const base = { revisionId: scopedInput.revisionId };
  if (!res.ok) {
    return { ...res, warnings: scoped.warnings, record: { ...res.record, ...base, warningCodes: codes(scoped.warnings) } };
  }
  const validated = validateAnswer(res.output, scoped.passages, opts.support);
  const warnings = [...scoped.warnings, ...validated.warnings];
  return {
    ok: true,
    output: validated.output,
    warnings,
    record: { ...res.record, ...base, outcome: validated.output.status, warningCodes: codes(warnings) },
  };
}

function codes(warnings: AnswerWarning[]): string[] {
  return [...new Set(warnings.map((w) => w.code))];
}
