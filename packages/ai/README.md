# @cerebro/ai

Task interfaces, providers, retrieval helpers and evaluation sets for Cerebro's
AI features. This package does no data access: the domain layer authorises,
scopes and stores everything (see `packages/domain`).

**AI provider: Anthropic (Claude), D12.** `AnthropicProvider` calls Claude
through the official `@anthropic-ai/sdk`. The default is still the offline
deterministic provider (T19): Claude runs only with
`CEREBRO_AI_PROVIDER=anthropic`, and only for organisations whose AI policy
lists `anthropic`. The generic AI SDK adapter (`ai-sdk`) remains for other
injected models.

## Tasks

Each task has a Zod input, a Zod output and a prompt version (`src/tasks.ts`).
Provider output is parsed against the output schema and validated again by the
caller.

| Task | Used for | Output is |
| --- | --- | --- |
| `answer` | Reader Q&A over one published revision | Validated by `runAnswer` (citations, numbers, revision scope) |
| `compose` | Draft from selected thinking and sources | A proposal; the author applies it |
| `propose_revision` | Author instruction → operations | Stored as a `revision` suggestion; applied only on accept |
| `suggest_perspectives` | Audience perspectives (Phase 3, D06) | Stored as `perspective` suggestions after `validateSuggestedPerspective` |
| `summarize_topics` | Aggregate reader topics (D07) | Counts recomputed by the domain layer |

`validateSuggestedPerspective(doc, perspective)` enforces D06 for AI
suggestions: emphasis may name only existing sections, implication links only
existing blocks, text may not mention unknown `ev_`/`blk_`/`sec_`/`psp_`/`itm_`
ids, and every number must already appear in the draft's stated content
(approved evidence only). Labels may not duplicate existing perspectives.

The deterministic provider suggests rule-based perspectives ("Decision makers",
"Finance", "Risk review", "Delivery", "Evidence review") only where the draft
has matching blocks, quotes those blocks verbatim as implications, and says in
its rationale that no model was used.

## Provider configuration

`createAiFromEnv(env)` builds the providers; the domain layer calls it once per
process through `loadAiRuntime()` (web start-up in `apps/web/instrumentation.ts`,
the worker in `apps/worker/src/main.ts`, and `npm run ai:eval`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CEREBRO_AI_PROVIDER` | `deterministic` | `deterministic`, `anthropic` or `ai-sdk` |
| `CEREBRO_AI_PROVIDER_ID` | `anthropic` / `ai-sdk` | Policy id for the model provider (default follows the provider kind). An organisation must list it in `organizations.settings.ai.allowedProviders` before any of its data is sent there |
| `CEREBRO_AI_MODEL` | `claude-opus-5-5` with `anthropic`; none otherwise | Model id; required with `ai-sdk` |
| `CEREBRO_AI_TASK_MODELS` | none | `anthropic` only: per-task model ids, `task=model,…` |
| `CEREBRO_AI_TASK_EFFORT` | none | `anthropic` only: per-task effort, `task=low\|medium\|high\|xhigh\|max,…` (defaults below) |
| `CEREBRO_AI_REFUSAL_FALLBACK` | `default` | `anthropic` only: `default` sends `fallbacks: "default"` (server-side refusal fallback); `off` omits it |
| `CEREBRO_AI_SDK_MODULE` | none | `ai-sdk` only: module to import at runtime, an installed package name or a path relative to the working directory |
| `CEREBRO_AI_SDK_EXPORT` | `default` | `ai-sdk` only: export of that module to use (see contract below) |
| `CEREBRO_EMBEDDINGS` | `none` | `none`, `local` (hashed bag-of-words, offline) or `ai-sdk` |
| `CEREBRO_AI_EMBEDDING_MODEL` | none | Embedding model id; required with `CEREBRO_EMBEDDINGS=ai-sdk` |
| `CEREBRO_AI_EMBEDDING_DIMENSIONS` | none | Vector length of that model; required with `CEREBRO_EMBEDDINGS=ai-sdk` and checked on every response |
| `CEREBRO_RETRIEVAL_MODE` | `fts` | `fts` or `hybrid`. Full-text stays the default until hybrid is measured on representative content (T20) |

Credentials are read by the provider package from its own variables. Cerebro
never reads, stores or logs them.

### Anthropic (Claude)

`CEREBRO_AI_PROVIDER=anthropic` builds `AnthropicProvider` (`src/anthropic-provider.ts`)
on an official SDK client. Credentials use the SDK's standard resolution
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile).
Start-up does not require them: a call without credentials fails as
`provider_error` and the domain falls back like any other failure. The SDK
client is created with logging off (so `ANTHROPIC_LOG=debug` cannot print
request bodies) and no SDK retries (fallback is the domain's job).

Each task is one `client.beta.messages.create` call:

- `model`: `CEREBRO_AI_MODEL` (default `claude-opus-5-5`) or the task's override.
- No `temperature`, `top_p`, `top_k`, `thinking` or `tool_choice`, and no
  assistant prefill. Thinking is always on for this model; `output_config.effort`
  controls its depth.
- `output_config.format`: a JSON schema derived from the task's output schema
  by `structuredOutputSchema` (`src/output-schema.ts`). It keeps the keywords
  structured outputs support (types, `enum`, `const`, `anyOf`, `$ref`,
  `additionalProperties: false`) and moves lengths, patterns and numeric bounds
  into descriptions. The response is validated against the full Zod schema
  afterwards, and callers validate again.
- `system`: the task's instructions as one block with
  `cache_control: {type: "ephemeral"}`; the volatile data (question, passages,
  document, sources) follows in the user turn. Caching only applies once the
  system prefix reaches the model's minimum cacheable length.
- `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`
  unless `CEREBRO_AI_REFUSAL_FALLBACK=off`: when Claude declines a request for
  policy reasons the API retries it on Anthropic's recommended fallback model
  within the same call. The run records the model that produced the answer.
  Fallback models are Anthropic models, so the organisation's policy approval
  (`anthropic`) covers them.

Provisional per-task settings (implementation placeholders to be measured
with `npm run ai:eval`, not agreed targets):

| Task | Effort | `max_tokens` (thinking + reply) |
| --- | --- | --- |
| `answer` | `low` (D27) | 8,000 |
| `summarize_topics` | `low` | 16,000 |
| `suggest_perspectives` | `medium` | 16,000 |
| `propose_revision` | `medium` | 32,000 |
| `compose` | `medium` | 32,000 |

Responses are read by `stop_reason` before any content:

| `stop_reason` | Result |
| --- | --- |
| `end_turn` | Text blocks parsed as JSON and validated against the task schema (`invalid_output` otherwise); thinking blocks are skipped by type |
| `refusal` (after any fallback) | `answer`: an honest `refused` abstention with no parts or citations. Other tasks: `provider_error`, so the domain falls back |
| `max_tokens`, `model_context_window_exceeded` | `invalid_output`; truncated JSON is never parsed |
| anything else | `invalid_output` |

Errors use the SDK's typed classes: `RateLimitError` (429),
`InternalServerError` (5xx, including 529 overloaded) and `APIConnectionError`
map to `unavailable`; `APIConnectionTimeoutError` and the task timeout map to
`timeout`; a caller abort is `aborted`; every other API error (400, 401, 403,
404, …) is `provider_error`. Messages carry status codes and stop reasons only.

Usage: `inputTokens` counts all input tokens, including cache reads and
writes, which are also reported as `cacheReadInputTokens` and
`cacheWriteInputTokens`. After a refusal fallback every attempt in
`usage.iterations` is summed. `ai_runs` stores input and output tokens;
the cache split appears in the `ai.run` log line.

Anthropic has no embeddings API. `CEREBRO_EMBEDDINGS` stays `none` or `local`
with this provider; choosing an embedding source for hybrid retrieval is still
an open decision.

### Module contract

The export named by `CEREBRO_AI_SDK_EXPORT` must be one of:

1. **An AI SDK provider instance** — an object or function with
   `languageModel(modelId)` returning an AI SDK language model, and, for
   `CEREBRO_EMBEDDINGS=ai-sdk`, `embeddingModel(modelId)` (or
   `textEmbeddingModel(modelId)`). The provider packages of the AI SDK export
   such an instance, so pointing `CEREBRO_AI_SDK_MODULE` at the package and
   `CEREBRO_AI_SDK_EXPORT` at its instance export is enough.
2. **A factory function** `(modelId: string) => LanguageModel`, for a small
   local adapter module (for example one that sets a base URL or region).

Misconfiguration fails fast with `AiConfigError`: an unknown value, a missing
required variable, a module that cannot be imported ("could not be loaded …
install the approved AI SDK provider package"), a missing export (the error
lists the module's exports), or an export that is neither shape. The web app
and worker refuse to start rather than silently using another provider.

### Routing, policy and fallback

The registry holds the configured provider first and the deterministic
provider last. For every call the candidates are filtered by the
organisation's AI policy, so an outage never sends data to a provider the
organisation has not approved. When a candidate fails with `unavailable`,
`timeout`, `provider_error`, `invalid_output` or `unsupported`, the next
approved candidate runs; with the defaults that is the local deterministic
provider. If no candidate succeeds, reader Q&A records a `failed` answer with
an honest "answers are unavailable" message and composition proposals report
`unavailable`; reading, manual editing and publishing never call a provider
(principle 6).

## Embeddings and hybrid retrieval

`EmbeddingProvider` (`src/embeddings.ts`) embeds text in batches and reports
its model label and dimensions. Implementations: `HashedEmbeddingProvider`
(offline, deterministic, 256 dimensions, model `hashed-bow-v1`; lexical only,
for tests and development) and `AiSdkEmbeddingProvider` (injected AI SDK
embedding model).

The domain `embed_revision` job fills `retrieval_chunks.embedding`,
`embedding_model` and `embedding_dims` for a published revision's reader
corpus only (published blocks and approved evidence). It never reads
`source_chunks`. It is enqueued after indexing only when embeddings are
configured and the organisation allows the embedding provider id.

With `CEREBRO_RETRIEVAL_MODE=hybrid`, reader retrieval fuses the full-text
ranking and the cosine-distance ranking with reciprocal rank fusion
(`reciprocalRankFusion`, k = 60) over chunks embedded with the same model and
dimensions as the question. A question that cannot be embedded, or a revision
without matching vectors, uses full-text only.

## Evaluation

```
npm run ai:eval
```

Runs the answer evaluation set (`src/eval`) against every configured provider
and the retrieval set (`packages/domain/src/quality/retrieval-benchmark.ts`,
full-text vs hybrid on the fictional strategy briefing through the real
indexing, embedding and retrieval code on in-memory PGlite). The console shows
metrics only; the full report is written to `.data/ai-eval/` (git-ignored) as
JSON and Markdown and may quote the fictional fixtures. No pass threshold is
applied: thresholds and the retrieval default are for the user to set.

With `CEREBRO_AI_PROVIDER=anthropic` the answer set also runs against Claude
when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set (or
`CEREBRO_AI_EVAL_LIVE=1` for an SDK profile); without credentials Claude is
skipped and the report says so. The answer set covers the `answer` task only.

```
npm run ai:live
```

An opt-in check that every task (`answer`, `compose`, `propose_revision`,
`suggest_perspectives`, `summarize_topics`) returns schema-valid output from
Claude with the real request shape. It is skipped unless an Anthropic
credential is set, prints categories, latency and token counts only, and
applies no quality threshold. The normal test suite uses a fake SDK client and
never touches the network.

Logging rule: prompts, model payloads, questions, passages and source text
never go to logs. `AiRunRecord` and `ai_runs` hold ids, labels, counts, latency
and error categories only.
