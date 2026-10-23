import { APICallError, generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { AiError } from "./errors";
import { buildPrompt } from "./prompts";
import type { AiProvider, AiUsage, ProviderResult, RunOptions } from "./provider";
import type { AiTask, AiTaskName, TaskInput, TaskOutput } from "./tasks";
import { TASK_NAMES } from "./tasks";

export interface AiSdkProviderOptions {
  /** Provider id used by org policy, e.g. the approved vendor's policy key. */
  id: string;
  /** An AI SDK language model instance, created by the caller. No vendor is imported here. */
  model: LanguageModel;
  /** Label for run records when the model does not report one. */
  modelLabel?: string;
  /** Tasks this provider may serve. Defaults to all. */
  tasks?: readonly AiTaskName[];
  /** SDK-level retries. Defaults to 0; retries are a policy decision of the caller. */
  maxRetries?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Adapter over the AI SDK (`ai` v7). Uses `generateText` with
 * `Output.object({ schema })` so the model's output is parsed against the
 * task's output schema. Prompt text is built here and never logged.
 */
export class AiSdkProvider implements AiProvider {
  readonly id: string;
  readonly model: string;
  readonly external = true;
  private readonly lm: LanguageModel;
  private readonly tasks: ReadonlySet<AiTaskName>;
  private readonly maxRetries: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly temperature: number | undefined;

  constructor(opts: AiSdkProviderOptions) {
    this.id = opts.id;
    this.lm = opts.model;
    this.model = opts.modelLabel ?? (typeof opts.model === "string" ? opts.model : opts.model.modelId);
    this.tasks = new Set(opts.tasks ?? TASK_NAMES);
    this.maxRetries = opts.maxRetries ?? 0;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.temperature = opts.temperature;
  }

  supports(task: AiTaskName): boolean {
    return this.tasks.has(task);
  }

  async run<T extends AiTask>(task: T, input: TaskInput<T>, opts: RunOptions): Promise<ProviderResult<TaskOutput<T>>> {
    if (!this.supports(task.name)) throw new AiError("unsupported", `${this.id} is not configured for ${task.name}`);
    const parsed = task.input.safeParse(input);
    if (!parsed.success) throw new AiError("invalid_input", `invalid ${task.name} input`);
    if (opts.signal?.aborted) throw new AiError("aborted", "run aborted before start");

    const { system, prompt } = buildPrompt(task.name, parsed.data);
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new AiError("timeout", "model call timed out")), opts.timeoutMs);
    const started = performance.now();
    try {
      const result = await generateText({
        model: this.lm,
        system,
        prompt,
        output: Output.object({ schema: task.output, name: task.name }),
        abortSignal: controller.signal,
        maxRetries: this.maxRetries,
        ...(this.maxOutputTokens !== undefined ? { maxOutputTokens: this.maxOutputTokens } : {}),
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      });
      const output = task.output.safeParse(result.output);
      if (!output.success) throw new AiError("invalid_output", `${task.name} output did not match its schema`);
      return {
        output: output.data as TaskOutput<T>,
        usage: toUsage(result.totalUsage),
        latencyMs: performance.now() - started,
        provider: this.id,
        model: result.response?.modelId || this.model,
      };
    } catch (err) {
      throw classify(err, controller.signal, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function toUsage(u: LanguageModelUsage | undefined): AiUsage {
  const out: AiUsage = {};
  if (u?.inputTokens !== undefined) out.inputTokens = u.inputTokens;
  if (u?.outputTokens !== undefined) out.outputTokens = u.outputTokens;
  if (u?.totalTokens !== undefined) out.totalTokens = u.totalTokens;
  return out;
}

/** Map SDK and transport errors to coarse categories. Messages carry no content. */
function classify(err: unknown, internal: AbortSignal, external: AbortSignal | undefined): AiError {
  if (err instanceof AiError) return err;
  if (internal.aborted) {
    if (internal.reason instanceof AiError && internal.reason.category === "timeout") return internal.reason;
    if (external?.aborted) return new AiError("aborted", "model call aborted", { cause: err });
    return new AiError("timeout", "model call timed out", { cause: err });
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (status === 429 || status >= 500 || status === 0) {
      return new AiError("unavailable", `model provider unavailable (${status || "network"})`, { cause: err });
    }
    return new AiError("provider_error", `model provider rejected the call (${status})`, { cause: err });
  }
  const name = err instanceof Error ? err.name : "";
  if (/NoObjectGenerated|NoOutputGenerated|TypeValidation|JSONParse|NoContentGenerated/.test(name)) {
    return new AiError("invalid_output", "model output could not be parsed", { cause: err });
  }
  return new AiError("provider_error", "model call failed", { cause: err });
}
