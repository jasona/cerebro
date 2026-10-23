import {
  createAiFromEnv,
  DeterministicProvider,
  ProviderRegistry,
  type EmbeddingProvider,
  type OrgAiPolicy,
  type RetrievalMode,
} from "@cerebro/ai";
import { organizations, type Executor } from "@cerebro/database";
import { eq } from "drizzle-orm";

/**
 * Process-wide AI runtime: the provider registry used by reader Q&A, topic
 * summaries and composition proposals, the optional embedding provider, and
 * the retrieval mode.
 *
 * Built once from the environment by `loadAiRuntime()` (see
 * `createAiFromEnv` in @cerebro/ai for the variables). The default is the
 * offline deterministic provider, no embeddings and full-text retrieval
 * (T19, T20). Hosts call `loadAiRuntime()` at start-up so a misconfiguration
 * fails fast. Org policy still decides which providers may receive an
 * organization's data.
 *
 * State lives on globalThis because Next.js may load this module more than
 * once (instrumentation and route bundles).
 */
export interface AiRuntime {
  registry: ProviderRegistry;
  embeddings: EmbeddingProvider | null;
  retrievalMode: RetrievalMode;
}

/**
 * Provisional AI operation settings. Implementation placeholders pending
 * review, not agreed targets.
 */
export const AI_SETTINGS = {
  /** Question embedding for hybrid retrieval; on timeout retrieval falls back to full-text. */
  questionEmbeddingTimeoutMs: 5_000,
  /** One embedding call per batch of retrieval chunks. */
  embedBatchSize: 64,
  embedTimeoutMs: 30_000,
  /** Perspective suggestions and revision proposals. */
  proposalTimeoutMs: 30_000,
} as const;

interface RuntimeState {
  loaded?: Promise<AiRuntime>;
  resolved?: AiRuntime;
  override?: Partial<AiRuntime>;
}

declare global {
  // eslint-disable-next-line no-var
  var __cerebroAiRuntime: RuntimeState | undefined;
}

const state = (): RuntimeState => (globalThis.__cerebroAiRuntime ??= {});

let fallbackRegistry: ProviderRegistry | undefined;
const defaultRegistry = () => (fallbackRegistry ??= new ProviderRegistry({ providers: [new DeterministicProvider()] }));

/**
 * Build the runtime from the environment once per process. Rejects with an
 * `AiConfigError` (and can be retried) when the configuration is invalid or
 * the named AI SDK module is not installed.
 */
export function loadAiRuntime(env: NodeJS.ProcessEnv = process.env): Promise<AiRuntime> {
  const s = state();
  s.loaded ??= createAiFromEnv(env).then(
    (setup) => {
      const rt: AiRuntime = { registry: setup.registry, embeddings: setup.embeddings, retrievalMode: setup.config.retrievalMode };
      s.resolved = rt;
      return rt;
    },
    (err: unknown) => {
      s.loaded = undefined;
      throw err;
    },
  );
  return s.loaded;
}

/** The effective runtime: environment configuration with any test/host overrides applied. */
export async function getAiRuntime(): Promise<AiRuntime> {
  const base = await loadAiRuntime();
  return { ...base, ...state().override };
}

/**
 * Like getAiRuntime, but never throws: a misconfigured runtime behaves as
 * "no provider available" so callers degrade honestly (principle 6).
 */
export async function getAiRuntimeOrNull(): Promise<AiRuntime | null> {
  try {
    return await getAiRuntime();
  } catch {
    const o = state().override;
    return o?.registry ? { registry: o.registry, embeddings: o.embeddings ?? null, retrievalMode: o.retrievalMode ?? "fts" } : null;
  }
}

/** Synchronous registry: override, else the loaded runtime, else the deterministic default. */
export function getAiRegistry(): ProviderRegistry {
  const s = state();
  return s.override?.registry ?? s.resolved?.registry ?? defaultRegistry();
}

/** Override the registry (tests, or hosts wiring providers in code). `undefined` clears the override. */
export function setAiRegistry(next: ProviderRegistry | undefined): void {
  const s = state();
  const { registry: _drop, ...rest } = s.override ?? {};
  s.override = next ? { ...rest, registry: next } : rest;
}

/** Override any part of the runtime (tests). `undefined` clears every override. */
export function setAiRuntime(next: Partial<AiRuntime> | undefined): void {
  state().override = next ? { ...state().override, ...next } : undefined;
}

export const DEFAULT_ALLOWED_PROVIDERS: readonly string[] = ["deterministic"];

/**
 * Organization AI policy from `organizations.settings.ai.allowedProviders`,
 * defaulting to the deterministic provider only. A malformed value is treated
 * as "no provider allowed" rather than widened to the default.
 */
export async function resolveOrgAiPolicy(tx: Executor, organizationId: string): Promise<OrgAiPolicy> {
  const [row] = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const ai = (row?.settings as { ai?: { allowedProviders?: unknown } } | null | undefined)?.ai;
  if (!ai || ai.allowedProviders === undefined) return { allowedProviders: DEFAULT_ALLOWED_PROVIDERS };
  const list = ai.allowedProviders;
  if (!Array.isArray(list) || !list.every((p): p is string => typeof p === "string")) return { allowedProviders: [] };
  return { allowedProviders: list };
}

/** The embedding provider if one is configured and the organization allows its provider id. */
export function allowedEmbeddings(rt: AiRuntime | null, policy: OrgAiPolicy): EmbeddingProvider | null {
  const e = rt?.embeddings ?? null;
  return e && policy.allowedProviders.includes(e.id) ? e : null;
}
