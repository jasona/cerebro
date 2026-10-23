import Anthropic from "@anthropic-ai/sdk";
import { AiError } from "./errors";
import { structuredOutputSchema } from "./output-schema";
import { buildPrompt } from "./prompts";
import type { AiProvider, AiUsage, ProviderResult, RunOptions } from "./provider";
import type { AiTask, AiTaskName, AnswerOutput, TaskInput, TaskOutput } from "./tasks";
import { TASK_NAMES } from "./tasks";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaUsage = Anthropic.Beta.Messages.BetaUsage;

/** The part of the official SDK client this provider uses. Tests inject a fake with the same shape. */
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      create(body: BetaCreateParams, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): PromiseLike<BetaMessage>;
    };
  };
}

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/** Model used when `CEREBRO_AI_MODEL` is unset. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Beta header for the `fallbacks: "default"` scalar form (server-side refusal fallback). */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicTaskSettings {
  /** `output_config.effort`. Thinking is always on for the default model; effort is the depth control. */
  effort: AnthropicEffort;
  /** Upper bound for thinking plus the JSON reply. */
  maxTokens: number;
}

/**
 * Provisional per-task settings. Implementation placeholders pending
 * measurement with `npm run ai:eval`, not agreed targets; each can be
 * overridden per task (`CEREBRO_AI_TASK_EFFORT`).
 *
 * - `answer`: low (D27). Reader Q&A is chat-like and latency-bound (the
 *   domain answer timeout); grounding comes from the retrieved passages and
 *   the domain's citation checks. On timeout the domain falls back to the
 *   local extractive answerer.
 * - `summarize_topics`: low. Grouping short questions into labels; counts are
 *   recomputed by the domain layer anyway.
 * - `suggest_perspectives`, `propose_revision`, `compose`: medium. Proposals
 *   the author reviews; `max_tokens` leaves room for a full document.
 */
export const ANTHROPIC_TASK_DEFAULTS: Readonly<Record<AiTaskName, AnthropicTaskSettings>> = Object.freeze({
  answer: { effort: "low", maxTokens: 8_000 },
  summarize_topics: { effort: "low", maxTokens: 16_000 },
  suggest_perspectives: { effort: "medium", maxTokens: 16_000 },
  propose_revision: { effort: "medium", maxTokens: 32_000 },
  compose: { effort: "medium", maxTokens: 32_000 },
});

export interface AnthropicProviderOptions {
  /** Policy id; organizations list it in `settings.ai.allowedProviders`. Default "anthropic". */
  id?: string;
  /** An official SDK client (or a fake with the same shape in tests). */
  client: AnthropicMessagesClient;
  /** Default model id. Default {@link ANTHROPIC_DEFAULT_MODEL}. */
  model?: string;
  /** Per-task model ids, e.g. a smaller model for topic summaries. */
  taskModels?: Partial<Record<AiTaskName, string>>;
  /** Per-task effort and output limits merged over {@link ANTHROPIC_TASK_DEFAULTS}. */
  taskSettings?: Partial<Record<AiTaskName, Partial<AnthropicTaskSettings>>>;
  /** Server-side refusal fallback (`fallbacks: "default"`). Default true. */
  refusalFallback?: boolean;
  /** SDK-level retries. Default 0: the domain falls back to the next approved provider instead. */
  maxRetries?: number;
  /** Tasks this provider may serve. Defaults to all. */
  tasks?: readonly AiTaskName[];
}

/** Shown to readers when the model declines a question (stored as a `refused` answer). */
export const MODEL_DECLINED_MESSAGE = "The assistant declined to answer this question. The briefing itself is unaffected.";

/**
 * Claude through the official Anthropic SDK (D12).
 *
 * Each task is one Messages API call with structured outputs
 * (`output_config.format`) built from the task's output schema, an explicit
 * `output_config.effort`, no sampling parameters, no prefill and no
 * `thinking` field (adaptive thinking is the model default). The stable
 * system instructions come first and carry `cache_control`; the volatile data
 * (question, passages, document) follows in the user turn.
 *
 * `stop_reason` is checked before content is read: `refusal` becomes an honest
 * `refused` answer for reader Q&A and an error for proposals; `max_tokens` and
 * context-window stops are `invalid_output` (truncated JSON is never parsed).
 * Transport failures map to the shared categories so the domain's fallback
 * (to the next approved provider, by default the local deterministic one)
 * and the usage recorder keep working. Nothing here logs prompt, passage or
 * output text.
 */
export class AnthropicProvider implements AiProvider {
  readonly id: string;
  readonly model: string;
  readonly external = true;
  private readonly client: AnthropicMessagesClient;
  private readonly taskModels: Partial<Record<AiTaskName, string>>;
  private readonly settings: Record<AiTaskName, AnthropicTaskSettings>;
  private readonly refusalFallback: boolean;
  private readonly maxRetries: number;
  private readonly tasks: ReadonlySet<AiTaskName>;
  private readonly schemas = new Map<AiTaskName, Record<string, unknown>>();

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id ?? "anthropic";
    this.client = opts.client;
    this.model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.taskModels = { ...opts.taskModels };
    this.settings = Object.fromEntries(
      TASK_NAMES.map((t) => [t, { ...ANTHROPIC_TASK_DEFAULTS[t], ...opts.taskSettings?.[t] }]),
    ) as Record<AiTaskName, AnthropicTaskSettings>;
    this.refusalFallback = opts.refusalFallback ?? true;
    this.maxRetries = opts.maxRetries ?? 0;
    this.tasks = new Set(opts.tasks ?? TASK_NAMES);
  }

  supports(task: AiTaskName): boolean {
    return this.tasks.has(task);
  }

  /** Model id used for a task (per-task override, else the default). */
  modelFor(task: AiTaskName): string {
    return this.taskModels[task] ?? this.model;
  }

  /** Effective effort and output limit for a task. */
  settingsFor(task: AiTaskName): AnthropicTaskSettings {
    return this.settings[task];
  }

  /** The request body for a task. Exposed for tests; contains prompt text, so never log it. */
  buildRequest<T extends AiTask>(task: T, input: TaskInput<T>): BetaCreateParams {
    const { system, prompt } = buildPrompt(task.name, input);
    const { effort, maxTokens } = this.settings[task.name];
    let schema = this.schemas.get(task.name);
    if (!schema) {
      schema = structuredOutputSchema(task.output);
      this.schemas.set(task.name, schema);
    }
    return {
      model: this.modelFor(task.name),
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
      output_config: { effort, format: { type: "json_schema", schema } },
      ...(this.refusalFallback ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  async run<T extends AiTask>(task: T, input: TaskInput<T>, opts: RunOptions): Promise<ProviderResult<TaskOutput<T>>> {
    if (!this.supports(task.name)) throw new AiError("unsupported", `${this.id} is not configured for ${task.name}`);
    const parsed = task.input.safeParse(input);
    if (!parsed.success) throw new AiError("invalid_input", `invalid ${task.name} input`);
    if (opts.signal?.aborted) throw new AiError("aborted", "run aborted before start");

    const body = this.buildRequest(task, parsed.data as TaskInput<T>);
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new AiError("timeout", "model call timed out")), opts.timeoutMs);
    const started = performance.now();
    try {
      const message = await this.client.beta.messages.create(body, {
        signal: controller.signal,
        timeout: opts.timeoutMs,
        maxRetries: this.maxRetries,
      });
      const output = this.readOutput(task, message);
      return {
        output,
        usage: anthropicUsage(message.usage),
        latencyMs: performance.now() - started,
        provider: this.id,
        // The model that produced the message (a fallback model after a refusal fallback).
        model: message.model || body.model,
      };
    } catch (err) {
      throw classify(err, controller.signal, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private readOutput<T extends AiTask>(task: T, message: BetaMessage): TaskOutput<T> {
    switch (message.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        break;
      case "refusal":
        // The whole fallback chain declined. Reader Q&A abstains honestly;
        // proposals report a provider error so the domain can fall back.
        if (task.name === "answer") {
          const refused: AnswerOutput = { status: "refused", answer: [], citations: [], missing: MODEL_DECLINED_MESSAGE };
          return refused as TaskOutput<T>;
        }
        throw new AiError("provider_error", `model declined the ${task.name} request (refusal)`);
      case "max_tokens":
      case "model_context_window_exceeded":
        throw new AiError("invalid_output", `${task.name} output was truncated (${message.stop_reason})`);
      default:
        throw new AiError("invalid_output", `${task.name} stopped unexpectedly (${message.stop_reason ?? "none"})`);
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiError("invalid_output", `${task.name} output was not valid JSON`);
    }
    const out = task.output.safeParse(json);
    if (!out.success) throw new AiError("invalid_output", `${task.name} output did not match its schema`);
    return out.data as TaskOutput<T>;
  }
}

/**
 * Token counts for the usage recorder. With a refusal fallback the top-level
 * usage covers only the attempt that produced the message, so every attempt in
 * `usage.iterations` is summed when present. `inputTokens` includes cache
 * reads and writes; they are also reported separately.
 */
export function anthropicUsage(u: BetaUsage | null | undefined): AiUsage {
  if (!u) return {};
  const attempts: readonly Partial<Record<"input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens", number | null>>[] =
    u.iterations && u.iterations.length > 0 ? u.iterations : [u];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const a of attempts) {
    input += a.input_tokens ?? 0;
    output += a.output_tokens ?? 0;
    cacheRead += a.cache_read_input_tokens ?? 0;
    cacheWrite += a.cache_creation_input_tokens ?? 0;
  }
  const inputTokens = input + cacheRead + cacheWrite;
  return {
    inputTokens,
    outputTokens: output,
    totalTokens: inputTokens + output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  };
}

/** Map SDK errors (typed classes, never message text) to coarse categories. Messages carry no content. */
function classify(err: unknown, internal: AbortSignal, external: AbortSignal | undefined): AiError {
  if (err instanceof AiError) return err;
  if (internal.aborted) {
    if (internal.reason instanceof AiError && internal.reason.category === "timeout") return internal.reason;
    if (external?.aborted) return new AiError("aborted", "model call aborted", { cause: err });
    return new AiError("timeout", "model call timed out", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiError("timeout", "model call timed out", { cause: err });
  if (err instanceof Anthropic.APIUserAbortError) return new AiError("aborted", "model call aborted", { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new AiError("unavailable", "model provider unreachable (network)", { cause: err });
  if (err instanceof Anthropic.RateLimitError) return new AiError("unavailable", "model provider rate limited the call (429)", { cause: err });
  if (err instanceof Anthropic.InternalServerError) {
    return new AiError("unavailable", `model provider unavailable (${err.status})`, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new AiError("provider_error", `model provider rejected the call (${err.status ?? "unknown"})`, { cause: err });
  }
  return new AiError("provider_error", "model call failed", { cause: err });
}
