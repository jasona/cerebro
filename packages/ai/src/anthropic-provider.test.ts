import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { strategyBriefing } from "@cerebro/briefing-schema";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_FALLBACK_BETA,
  AnswerTask,
  AnthropicProvider,
  DeterministicProvider,
  EVAL_REVISION_ID,
  LOCAL_PASSAGES,
  MODEL_DECLINED_MESSAGE,
  SuggestPerspectivesTask,
  SummarizeTopicsTask,
  TASKS,
  TASK_NAMES,
  anthropicUsage,
  createAiFromEnv,
  readAiEnv,
  runAnswer,
  runTask,
  structuredOutputSchema,
  AiConfigError,
  type AiProvider,
  type AnswerInput,
  type AnthropicMessagesClient,
} from "./index";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateOptions = Parameters<AnthropicMessagesClient["beta"]["messages"]["create"]>[1];

const input: AnswerInput = { question: "What does the migration cost?", revisionId: EVAL_REVISION_ID, passages: [...LOCAL_PASSAGES] };
const opts = { timeoutMs: 5_000 };

interface FakeCall {
  body: BetaCreateParams;
  options: CreateOptions;
}

/** A fake SDK client at the module boundary: records requests, never touches the network. */
function fakeClient(impl: (body: BetaCreateParams, options: CreateOptions) => Promise<BetaMessage>) {
  const calls: FakeCall[] = [];
  const client: AnthropicMessagesClient = {
    beta: {
      messages: {
        create(body, options) {
          calls.push({ body, options });
          return impl(body, options);
        },
      },
    },
  };
  return { client, calls };
}

function message(patch: {
  stop_reason: BetaMessage["stop_reason"];
  json?: unknown;
  text?: string;
  model?: string;
  usage?: Partial<Anthropic.Beta.Messages.BetaUsage>;
}): BetaMessage {
  const text = patch.text ?? (patch.json === undefined ? "" : JSON.stringify(patch.json));
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: patch.model ?? ANTHROPIC_DEFAULT_MODEL,
    // Thinking blocks come first and are skipped by type, not position.
    content: [{ type: "thinking", thinking: "", signature: "sig" }, ...(text ? [{ type: "text", text, citations: null }] : [])],
    stop_reason: patch.stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 600,
      iterations: null,
      ...patch.usage,
    },
  } as unknown as BetaMessage;
}

const answered = {
  status: "answered",
  answer: [{ text: LOCAL_PASSAGES[0]!.text.split(". ")[0]!, kind: "stated", citations: [LOCAL_PASSAGES[0]!.id] }],
  citations: [{ passageId: LOCAL_PASSAGES[0]!.id }],
};

/** The SDK's own typed error for a status (RateLimitError for 429, InternalServerError for 5xx, …). */
const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error" }, "boom", new Headers());

describe("AnthropicProvider request shape", () => {
  it("sends the model, effort, structured output schema, refusal fallback and a cached system prompt, with no sampling parameters", async () => {
    const { client, calls } = fakeClient(async () => message({ stop_reason: "end_turn", json: answered }));
    const provider = new AnthropicProvider({ client });
    await provider.run(AnswerTask, input, opts);

    expect(calls).toHaveLength(1);
    const { body, options } = calls[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    for (const key of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) expect(body).not.toHaveProperty(key);
    expect(body.output_config?.effort).toBe("low");
    expect(body.output_config?.format).toEqual({ type: "json_schema", schema: structuredOutputSchema(AnswerTask.output) });
    expect(body.betas).toEqual([ANTHROPIC_FALLBACK_BETA]);
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.fallbacks).toBe("default");
    expect(body.max_tokens).toBeGreaterThan(0);

    // Stable instructions first, cached; volatile data (passages, question) after, uncached. No prefill.
    expect(Array.isArray(body.system)).toBe(true);
    const system = body.system as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).not.toContain(input.question);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("user");
    expect(typeof body.messages[0]!.content).toBe("string");
    expect(body.messages[0]!.content as string).toContain('<data name="question">');
    expect(body.messages[0]!.content as string).toContain(LOCAL_PASSAGES[0]!.id);

    // The task timeout reaches the SDK, and SDK retries are off (the domain falls back instead).
    expect(options?.timeout).toBe(opts.timeoutMs);
    expect(options?.maxRetries).toBe(0);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses per-task effort and model overrides, and can turn the refusal fallback off", async () => {
    const { client, calls } = fakeClient(async () => message({ stop_reason: "end_turn", json: { topics: [], suppressedQuestions: 0 } }));
    const provider = new AnthropicProvider({
      client,
      taskModels: { summarize_topics: "claude-small-test" },
      taskSettings: { answer: { effort: "high" } },
      refusalFallback: false,
    });
    expect(provider.settingsFor("summarize_topics").effort).toBe("low");
    expect(provider.settingsFor("answer").effort).toBe("high");
    expect(provider.settingsFor("suggest_perspectives").effort).toBe("medium");

    await provider.run(SummarizeTopicsTask, { questions: [{ id: "q1", text: "When?", readerHash: "h1" }] }, opts);
    const { body } = calls[0]!;
    expect(body.model).toBe("claude-small-test");
    expect(body.output_config?.effort).toBe("low");
    expect(body).not.toHaveProperty("betas");
    expect(body).not.toHaveProperty("fallbacks");
  });

  it("builds a request for every task", () => {
    const provider = new AnthropicProvider({ client: fakeClient(async () => message({ stop_reason: "end_turn" })).client });
    const inputs = {
      compose: { sources: [], handoffText: "Our position: consolidate the platforms." },
      propose_revision: { document: strategyBriefing, instruction: "Tighten the summary." },
      answer: input,
      summarize_topics: { questions: [] },
      suggest_perspectives: { document: strategyBriefing },
    } as const;
    for (const name of TASK_NAMES) {
      const task = TASKS[name];
      const body = provider.buildRequest(task, task.input.parse(inputs[name]) as never);
      expect(body.output_config?.effort, name).toBe(provider.settingsFor(name).effort);
      expect(body.output_config?.format?.schema, name).toEqual(structuredOutputSchema(task.output));
    }
  });
});

describe("structuredOutputSchema", () => {
  const UNSUPPORTED = ["minLength", "maxLength", "pattern", "minimum", "maximum", "maxItems", "default", "$schema", "oneOf"];

  function nodes(schema: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(schema)) schema.forEach((s) => nodes(s, out));
    else if (schema && typeof schema === "object") {
      const n = schema as Record<string, unknown>;
      out.push(n);
      for (const [k, v] of Object.entries(n)) {
        if (k === "properties" || k === "$defs") Object.values(v as object).forEach((s) => nodes(s, out));
        else if (k === "items" || k === "anyOf" || k === "allOf") nodes(v, out);
      }
    }
    return out;
  }

  it.each(TASK_NAMES)("keeps %s within the supported subset", (name) => {
    const schema = structuredOutputSchema(TASKS[name].output);
    for (const n of nodes(schema)) {
      for (const key of UNSUPPORTED) expect(n, `${name}: ${key}`).not.toHaveProperty(key);
      if (n.type === "object") expect(n.additionalProperties).toBe(false);
      if (n.additionalProperties !== undefined) expect(n.additionalProperties).toBe(false);
      if (n.minItems !== undefined) expect([0, 1]).toContain(n.minItems);
      const typed = n.type !== undefined || n.$ref !== undefined || n.anyOf !== undefined || n.allOf !== undefined || n.const !== undefined || n.enum !== undefined;
      expect(typed, `${name}: untyped node ${JSON.stringify(n).slice(0, 80)}`).toBe(true);
    }
  });

  it("keeps enums as constraints and moves other limits into descriptions", () => {
    const schema = structuredOutputSchema(AnswerTask.output) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.status!.enum).toEqual(["answered", "insufficient", "refused"]);
    expect(String(schema.properties.missing!.description)).toContain('"maxLength":1000');
  });
});

describe("AnthropicProvider responses", () => {
  it("parses structured output and reports usage including cache tokens and the serving model", async () => {
    const { client } = fakeClient(async () =>
      message({ stop_reason: "end_turn", json: answered, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 700, cache_creation_input_tokens: 30 } }),
    );
    const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.status).toBe("answered");
    expect(res.record).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", status: "succeeded", outcome: "answered" });
    expect(res.record.usage).toEqual({
      inputTokens: 830,
      outputTokens: 50,
      totalTokens: 880,
      cacheReadInputTokens: 700,
      cacheWriteInputTokens: 30,
    });
  });

  it("sums every attempt after a server-side refusal fallback and records the model that answered", () => {
    const usage = anthropicUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ],
    } as unknown as Anthropic.Beta.Messages.BetaUsage);
    expect(usage).toMatchObject({ inputTokens: 250, outputTokens: 20, totalTokens: 270, cacheReadInputTokens: 50 });
  });

  it("records the fallback model as the run's model", async () => {
    const { client } = fakeClient(async () => message({ stop_reason: "end_turn", json: answered, model: "claude-opus-4-8" }));
    const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
    expect(res.record.model).toBe("claude-opus-4-8");
  });

  it("treats a refusal of a reader question as an honest abstention", async () => {
    const { client } = fakeClient(async () => message({ stop_reason: "refusal" }));
    const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output).toEqual({ status: "refused", answer: [], citations: [], missing: MODEL_DECLINED_MESSAGE });
    expect(res.record.outcome).toBe("refused");
  });

  it("reports a refused proposal as a provider error so the domain can fall back", async () => {
    const { client } = fakeClient(async () => message({ stop_reason: "refusal" }));
    const res = await runTask(new AnthropicProvider({ client }), SuggestPerspectivesTask, { document: strategyBriefing }, opts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.category).toBe("provider_error");
  });

  it.each([
    ["max_tokens", '{"status":"answ'],
    ["model_context_window_exceeded", '{"status":"answ'],
    ["pause_turn", ""],
  ] as const)("never parses output that stopped with %s", async (stop, text) => {
    const { client } = fakeClient(async () => message({ stop_reason: stop, text }));
    const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.category).toBe("invalid_output");
  });

  it("rejects invalid JSON and output that does not match the task schema", async () => {
    for (const text of ["not json", JSON.stringify({ status: "maybe", answer: [], citations: [] })]) {
      const { client } = fakeClient(async () => message({ stop_reason: "end_turn", text }));
      const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.category).toBe("invalid_output");
    }
  });
});

describe("AnthropicProvider errors", () => {
  it("uses the SDK's typed error classes", () => {
    expect(apiError(429)).toBeInstanceOf(Anthropic.RateLimitError);
    expect(apiError(529)).toBeInstanceOf(Anthropic.InternalServerError);
    expect(apiError(401)).toBeInstanceOf(Anthropic.AuthenticationError);
  });

  it.each([
    ["rate limit (429)", () => apiError(429), "unavailable"],
    ["overloaded (529)", () => apiError(529), "unavailable"],
    ["server error (500)", () => apiError(500), "unavailable"],
    ["network", () => new Anthropic.APIConnectionError({ message: "socket hang up" }), "unavailable"],
    ["SDK timeout", () => new Anthropic.APIConnectionTimeoutError(), "timeout"],
    ["authentication (401)", () => apiError(401), "provider_error"],
    ["bad request (400)", () => apiError(400), "provider_error"],
    ["unknown", () => new Error("weird"), "provider_error"],
  ] as const)("maps %s to %s", async (_label, make, category) => {
    const { client } = fakeClient(async () => {
      throw make();
    });
    const res = await runAnswer(new AnthropicProvider({ client }), input, opts);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.category).toBe(category);
      expect(res.record.errorCategory).toBe(category);
      // Error text carries categories and status codes only.
      expect(res.error.message).not.toContain(input.question);
    }
  });

  it("times out a hanging call and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const { client } = fakeClient((_body, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const res = await runAnswer(new AnthropicProvider({ client }), input, { timeoutMs: 30 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.category).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("reports a caller abort as aborted", async () => {
    const controller = new AbortController();
    const { client } = fakeClient(
      (_body, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
        }),
    );
    const pending = new AnthropicProvider({ client }).run(AnswerTask, input, { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "aborted" });
  });

  it("falls back to the deterministic provider on an outage, as the domain does", async () => {
    const { client } = fakeClient(async () => {
      throw apiError(529);
    });
    const candidates: AiProvider[] = [new AnthropicProvider({ client }), new DeterministicProvider()];
    const records = [];
    let answeredBy: string | undefined;
    for (const p of candidates) {
      const res = await runAnswer(p, input, opts);
      records.push(res.record);
      if (res.ok) {
        answeredBy = res.record.provider;
        break;
      }
    }
    expect(records.map((r) => [r.provider, r.status, r.errorCategory])).toEqual([
      ["anthropic", "failed", "unavailable"],
      ["deterministic", "succeeded", null],
    ]);
    expect(answeredBy).toBe("deterministic");
  });
});

describe("createAiFromEnv with CEREBRO_AI_PROVIDER=anthropic", () => {
  it("defaults to claude-opus-5-5 under the policy id \"anthropic\", ahead of the local fallback", async () => {
    const { client } = fakeClient(async () => message({ stop_reason: "end_turn", json: answered }));
    const setup = await createAiFromEnv({ CEREBRO_AI_PROVIDER: "anthropic" }, { anthropicClient: client });
    expect(setup.config).toMatchObject({ provider: "anthropic", providerId: "anthropic", model: "claude-opus-5-5", refusalFallback: true, embeddings: "none" });
    expect(setup.providers.map((p) => p.id)).toEqual(["anthropic", "deterministic"]);
    expect(setup.providers[0]!.model).toBe("claude-opus-5-5");
    // Organization policy still decides: without "anthropic" in allowedProviders no data is sent there.
    expect(setup.registry.candidates("answer", { allowedProviders: ["deterministic"] }).map((p) => p.id)).toEqual(["deterministic"]);
    expect(setup.registry.candidates("answer", { allowedProviders: ["anthropic", "deterministic"] }).map((p) => p.id)).toEqual(["anthropic", "deterministic"]);
  });

  it("applies model, per-task model and effort overrides, and the fallback switch", async () => {
    const { client, calls } = fakeClient(async () => message({ stop_reason: "end_turn", json: answered }));
    const setup = await createAiFromEnv(
      {
        CEREBRO_AI_PROVIDER: "anthropic",
        CEREBRO_AI_MODEL: "claude-opus-5",
        CEREBRO_AI_TASK_MODELS: "summarize_topics=claude-haiku-5-5",
        CEREBRO_AI_TASK_EFFORT: "answer=low, compose=high",
        CEREBRO_AI_REFUSAL_FALLBACK: "off",
      },
      { anthropicClient: client },
    );
    const provider = setup.providers[0] as AnthropicProvider;
    expect(provider.modelFor("answer")).toBe("claude-opus-5");
    expect(provider.modelFor("summarize_topics")).toBe("claude-haiku-5-5");
    expect(provider.settingsFor("answer").effort).toBe("low");
    expect(provider.settingsFor("compose").effort).toBe("high");
    await provider.run(AnswerTask, input, opts);
    expect(calls[0]!.body).not.toHaveProperty("fallbacks");
    expect(calls[0]!.body.output_config?.effort).toBe("low");
  });

  it("rejects malformed overrides with a clear error", () => {
    const base = { CEREBRO_AI_PROVIDER: "anthropic" };
    expect(() => readAiEnv({ ...base, CEREBRO_AI_TASK_EFFORT: "answer=extreme" })).toThrow(AiConfigError);
    expect(() => readAiEnv({ ...base, CEREBRO_AI_TASK_EFFORT: "chat=low" })).toThrow(/unknown task/);
    expect(() => readAiEnv({ ...base, CEREBRO_AI_TASK_MODELS: "answer" })).toThrow(/task=value/);
    expect(() => readAiEnv({ ...base, CEREBRO_AI_REFUSAL_FALLBACK: "maybe" })).toThrow(AiConfigError);
    expect(() => readAiEnv({ CEREBRO_AI_TASK_EFFORT: "answer=low" })).toThrow(/only to CEREBRO_AI_PROVIDER=anthropic/);
    expect(() => readAiEnv({ ...base, CEREBRO_AI_PROVIDER_ID: "deterministic" })).toThrow(AiConfigError);
  });

  it("keeps embeddings separate: Anthropic has no embeddings API", () => {
    expect(readAiEnv({ CEREBRO_AI_PROVIDER: "anthropic" }).embeddings).toBe("none");
    expect(readAiEnv({ CEREBRO_AI_PROVIDER: "anthropic", CEREBRO_EMBEDDINGS: "local" }).embeddings).toBe("local");
  });
});
