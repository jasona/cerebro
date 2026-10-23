import { APICallError, embedMany, type EmbeddingModel } from "ai";
import { AiError } from "./errors";
import { terms } from "./text";

/**
 * Embedding contract (W3.2). Embeddings are a projection of the reader
 * retrieval corpus (published blocks and approved evidence only); the domain
 * layer decides what is embedded. Implementations must not log input text.
 *
 * Vector spaces are not interchangeable: every stored vector records the
 * `model` and `dimensions` that produced it, and retrieval only compares
 * vectors with the same pair (AI_AND_EVIDENCE.md "Provider policy").
 */
export interface EmbeddingProvider {
  /** Stable id used by organisation policy, like {@link AiProvider.id}. */
  readonly id: string;
  /** Model label stored with each vector (`retrieval_chunks.embedding_model`). */
  readonly model: string;
  /** Vector length produced by this provider. */
  readonly dimensions: number;
  /** Whether input text leaves this process. Informational; policy still applies. */
  readonly external: boolean;
  embed(texts: readonly string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<EmbedResult>;
}

export interface EmbedResult {
  embeddings: number[][];
  /** Token usage when the provider reports it. */
  tokens?: number;
}

// ---------------------------------------------------------------------------
// Deterministic local embeddings
// ---------------------------------------------------------------------------

export const HASHED_EMBEDDING_MODEL = "hashed-bow-v1";
export const HASHED_EMBEDDING_DIMENSIONS = 256;

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Feature-hashed bag of words: stemmed content terms plus adjacent-term
 * bigrams, signed-hashed into a fixed number of buckets, sublinear term
 * frequency, L2-normalised. Offline and deterministic, for tests and local
 * development. It captures lexical overlap only (no synonyms), so it is a
 * stand-in for measuring the hybrid pipeline, not a semantic model.
 */
export function hashedEmbedding(text: string, dimensions = HASHED_EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  const ts = terms(text);
  const counts = new Map<string, number>();
  ts.forEach((t, i) => {
    counts.set(t, (counts.get(t) ?? 0) + 1);
    const next = ts[i + 1];
    if (next) counts.set(`${t} ${next}`, (counts.get(`${t} ${next}`) ?? 0) + 0.5);
  });
  for (const [feature, tf] of counts) {
    const h = fnv1a(feature);
    const sign = (h & 0x80000000) === 0 ? 1 : -1;
    v[h % dimensions]! += sign * (1 + Math.log(tf));
  }
  return normalize(v);
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new AiError("invalid_input", "vector dimensions differ");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class HashedEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly external = false;

  constructor(opts: { id?: string; dimensions?: number } = {}) {
    this.id = opts.id ?? "deterministic";
    this.dimensions = opts.dimensions ?? HASHED_EMBEDDING_DIMENSIONS;
    this.model = this.dimensions === HASHED_EMBEDDING_DIMENSIONS ? HASHED_EMBEDDING_MODEL : `${HASHED_EMBEDDING_MODEL}-${this.dimensions}`;
  }

  async embed(texts: readonly string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<EmbedResult> {
    if (opts.signal?.aborted) throw new AiError("aborted", "embedding aborted before start");
    return { embeddings: texts.map((t) => hashedEmbedding(t, this.dimensions)) };
  }
}

// ---------------------------------------------------------------------------
// AI SDK embeddings (injected model; no vendor imported here)
// ---------------------------------------------------------------------------

export interface AiSdkEmbeddingProviderOptions {
  id: string;
  model: EmbeddingModel;
  /** Label stored with vectors when the model does not report one. */
  modelLabel?: string;
  /** Expected vector length. Checked on every response; a mismatch fails the run. */
  dimensions: number;
  maxRetries?: number;
}

export class AiSdkEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly external = true;
  private readonly em: EmbeddingModel;
  private readonly maxRetries: number;

  constructor(opts: AiSdkEmbeddingProviderOptions) {
    this.id = opts.id;
    this.em = opts.model;
    this.model = opts.modelLabel ?? (typeof opts.model === "string" ? opts.model : opts.model.modelId);
    this.dimensions = opts.dimensions;
    this.maxRetries = opts.maxRetries ?? 0;
  }

  async embed(texts: readonly string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<EmbedResult> {
    if (opts.signal?.aborted) throw new AiError("aborted", "embedding aborted before start");
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new AiError("timeout", "embedding call timed out")), opts.timeoutMs);
    try {
      const res = await embedMany({ model: this.em, values: [...texts], abortSignal: controller.signal, maxRetries: this.maxRetries });
      for (const e of res.embeddings) {
        if (e.length !== this.dimensions) throw new AiError("invalid_output", "embedding dimensions differ from configuration");
      }
      return { embeddings: res.embeddings.map((e) => [...e]), ...(res.usage?.tokens !== undefined ? { tokens: res.usage.tokens } : {}) };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (controller.signal.aborted) {
        throw opts.signal?.aborted
          ? new AiError("aborted", "embedding aborted", { cause: err })
          : new AiError("timeout", "embedding call timed out", { cause: err });
      }
      if (APICallError.isInstance(err)) {
        const status = err.statusCode ?? 0;
        if (status === 429 || status >= 500 || status === 0) throw new AiError("unavailable", `embedding provider unavailable (${status || "network"})`, { cause: err });
        throw new AiError("provider_error", `embedding provider rejected the request (${status})`, { cause: err });
      }
      throw new AiError("provider_error", "embedding provider failed", { cause: err });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Rank fusion
// ---------------------------------------------------------------------------

/** Conventional RRF constant (Cormack, Clarke and Büttcher, 2009). A ranking parameter, not a quality target. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion of several ranked id lists: score(id) = Σ 1/(k + rank).
 * Ties keep first-seen order, so the result is deterministic. Fusion only
 * reorders ids it is given; it never adds any.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
