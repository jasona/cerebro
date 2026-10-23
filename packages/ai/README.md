# @cerebro/ai

Task interfaces, providers, retrieval helpers and evaluation sets for Cerebro's
AI features. This package does no data access: the domain layer authorises,
scopes and stores everything (see `packages/domain`).

**No AI vendor is selected.** Nothing here imports or names one. The default is
the offline deterministic provider (T19), and connecting an approved provider
later is configuration plus installing one package.

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
| `CEREBRO_AI_PROVIDER` | `deterministic` | `deterministic` or `ai-sdk` |
| `CEREBRO_AI_PROVIDER_ID` | `ai-sdk` | Policy id for the model provider. An organisation must list it in `organizations.settings.ai.allowedProviders` before any of its data is sent there |
| `CEREBRO_AI_SDK_MODULE` | none | Module to import at runtime: an installed package name, or a path relative to the working directory |
| `CEREBRO_AI_SDK_EXPORT` | `default` | Export of that module to use (see contract below) |
| `CEREBRO_AI_MODEL` | none | Model id; required with `ai-sdk` |
| `CEREBRO_EMBEDDINGS` | `none` | `none`, `local` (hashed bag-of-words, offline) or `ai-sdk` |
| `CEREBRO_AI_EMBEDDING_MODEL` | none | Embedding model id; required with `CEREBRO_EMBEDDINGS=ai-sdk` |
| `CEREBRO_AI_EMBEDDING_DIMENSIONS` | none | Vector length of that model; required with `CEREBRO_EMBEDDINGS=ai-sdk` and checked on every response |
| `CEREBRO_RETRIEVAL_MODE` | `fts` | `fts` or `hybrid`. Full-text stays the default until hybrid is measured on representative content (T20) |

Credentials are read by the provider package from its own variables. Cerebro
never reads, stores or logs them.

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

Logging rule: prompts, model payloads, questions, passages and source text
never go to logs. `AiRunRecord` and `ai_runs` hold ids, labels, counts, latency
and error categories only.
