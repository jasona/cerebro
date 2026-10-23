import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingModel, LanguageModel } from "ai";
import { AiSdkProvider } from "./ai-sdk-provider";
import { DeterministicProvider } from "./deterministic";
import { AiSdkEmbeddingProvider, HashedEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { ProviderRegistry, type AiProvider } from "./provider";

/**
 * Provider wiring from the environment (W2.4). No AI vendor is selected, so
 * nothing here names or imports one: the default is the offline deterministic
 * provider, and `CEREBRO_AI_PROVIDER=ai-sdk` loads an AI SDK provider module
 * named at runtime. Connecting an approved provider later is configuration
 * plus installing that one package. See packages/ai/README.md.
 *
 * | Variable | Default | Meaning |
 * | --- | --- | --- |
 * | CEREBRO_AI_PROVIDER | deterministic | `deterministic` or `ai-sdk` |
 * | CEREBRO_AI_PROVIDER_ID | ai-sdk | Policy id of the model provider; organisations must list it in `settings.ai.allowedProviders` |
 * | CEREBRO_AI_SDK_MODULE | (none) | Module specifier to import (package name, or a path relative to the working directory) |
 * | CEREBRO_AI_SDK_EXPORT | default | Export of that module: an AI SDK provider (has `languageModel(id)`) or a function `(modelId) => LanguageModel` |
 * | CEREBRO_AI_MODEL | (none) | Model id passed to the export; required with `ai-sdk` |
 * | CEREBRO_EMBEDDINGS | none | `none`, `local` (hashed, offline) or `ai-sdk` (same module; needs `embeddingModel(id)`) |
 * | CEREBRO_AI_EMBEDDING_MODEL | (none) | Embedding model id; required with `CEREBRO_EMBEDDINGS=ai-sdk` |
 * | CEREBRO_AI_EMBEDDING_DIMENSIONS | (none) | Vector length that model returns; required with `CEREBRO_EMBEDDINGS=ai-sdk` |
 * | CEREBRO_RETRIEVAL_MODE | fts | `fts` or `hybrid` (full-text + vector, reciprocal rank fusion). Full-text stays the default until measured (T20) |
 *
 * Credentials are read by the provider package itself from its own variables;
 * Cerebro never reads, stores or logs them.
 */

export const AI_PROVIDER_KINDS = ["deterministic", "ai-sdk"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
export const EMBEDDING_KINDS = ["none", "local", "ai-sdk"] as const;
export type EmbeddingKind = (typeof EMBEDDING_KINDS)[number];
export const RETRIEVAL_MODES = ["fts", "hybrid"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export interface AiEnvConfig {
  provider: AiProviderKind;
  providerId: string;
  sdkModule?: string;
  sdkExport: string;
  model?: string;
  embeddings: EmbeddingKind;
  embeddingModel?: string;
  embeddingDimensions?: number;
  retrievalMode: RetrievalMode;
}

/** Misconfiguration. Messages name variables and values of non-secret settings only. */
export class AiConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiConfigError";
  }
}

const POLICY_ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

function pick<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new AiConfigError(`${name}=${JSON.stringify(raw)} is not supported; use one of: ${allowed.join(", ")}.`);
  }
  return raw as T;
}

/** Parse and check the AI settings. Throws {@link AiConfigError} on an invalid or incomplete combination. */
export function readAiEnv(env: NodeJS.ProcessEnv = process.env): AiEnvConfig {
  const provider = pick(env, "CEREBRO_AI_PROVIDER", AI_PROVIDER_KINDS, "deterministic");
  const embeddings = pick(env, "CEREBRO_EMBEDDINGS", EMBEDDING_KINDS, "none");
  const retrievalMode = pick(env, "CEREBRO_RETRIEVAL_MODE", RETRIEVAL_MODES, "fts");
  const providerId = env.CEREBRO_AI_PROVIDER_ID?.trim() || "ai-sdk";
  if (!POLICY_ID.test(providerId) || providerId === "deterministic") {
    throw new AiConfigError("CEREBRO_AI_PROVIDER_ID must be a short id (letters, digits, _ . -) other than \"deterministic\".");
  }
  const sdkModule = env.CEREBRO_AI_SDK_MODULE?.trim() || undefined;
  const model = env.CEREBRO_AI_MODEL?.trim() || undefined;
  const embeddingModel = env.CEREBRO_AI_EMBEDDING_MODEL?.trim() || undefined;
  const dimsRaw = env.CEREBRO_AI_EMBEDDING_DIMENSIONS?.trim();
  const embeddingDimensions = dimsRaw ? Number(dimsRaw) : undefined;
  if (embeddingDimensions !== undefined && (!Number.isInteger(embeddingDimensions) || embeddingDimensions < 1 || embeddingDimensions > 16_000)) {
    throw new AiConfigError("CEREBRO_AI_EMBEDDING_DIMENSIONS must be a positive integer.");
  }

  const needsModule = provider === "ai-sdk" || embeddings === "ai-sdk";
  if (needsModule && !sdkModule) {
    throw new AiConfigError("CEREBRO_AI_SDK_MODULE is required when CEREBRO_AI_PROVIDER or CEREBRO_EMBEDDINGS is \"ai-sdk\".");
  }
  if (provider === "ai-sdk" && !model) throw new AiConfigError("CEREBRO_AI_MODEL is required when CEREBRO_AI_PROVIDER=ai-sdk.");
  if (embeddings === "ai-sdk" && (!embeddingModel || embeddingDimensions === undefined)) {
    throw new AiConfigError("CEREBRO_AI_EMBEDDING_MODEL and CEREBRO_AI_EMBEDDING_DIMENSIONS are required when CEREBRO_EMBEDDINGS=ai-sdk.");
  }

  return {
    provider,
    providerId,
    ...(sdkModule ? { sdkModule } : {}),
    sdkExport: env.CEREBRO_AI_SDK_EXPORT?.trim() || "default",
    ...(model ? { model } : {}),
    embeddings,
    ...(embeddingModel ? { embeddingModel } : {}),
    ...(embeddingDimensions !== undefined ? { embeddingDimensions } : {}),
    retrievalMode,
  };
}

export type ModuleImporter = (specifier: string) => Promise<Record<string, unknown>>;

/** Import a package name, or a file path relative to the working directory, at runtime (not bundled). */
export const importAiModule: ModuleImporter = async (specifier) => {
  const target = specifier.startsWith(".") || isAbsolute(specifier) ? pathToFileURL(resolve(process.cwd(), specifier)).href : specifier;
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ target)) as Record<string, unknown>;
};

interface SdkProviderLike {
  languageModel?: (id: string) => unknown;
  embeddingModel?: (id: string) => unknown;
  textEmbeddingModel?: (id: string) => unknown;
}

async function loadSdkExport(cfg: AiEnvConfig, importer: ModuleImporter): Promise<unknown> {
  const spec = cfg.sdkModule!;
  let mod: Record<string, unknown>;
  try {
    mod = await importer(spec);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    throw new AiConfigError(
      `CEREBRO_AI_SDK_MODULE=${JSON.stringify(spec)} could not be loaded${typeof code === "string" ? ` (${code})` : ""}. ` +
        "Install the approved AI SDK provider package at the repository root (npm install <package>), or point CEREBRO_AI_SDK_MODULE at a local adapter module. See packages/ai/README.md.",
      { cause: err },
    );
  }
  const exp = mod[cfg.sdkExport];
  if (exp === undefined || exp === null) {
    const names = Object.keys(mod).slice(0, 20).join(", ") || "none";
    throw new AiConfigError(
      `Module ${JSON.stringify(spec)} has no export ${JSON.stringify(cfg.sdkExport)} (exports: ${names}). Set CEREBRO_AI_SDK_EXPORT to the provider instance or factory export.`,
    );
  }
  return exp;
}

function isModelLike(v: unknown): boolean {
  return typeof v === "string" || (typeof v === "object" && v !== null && typeof (v as { modelId?: unknown }).modelId === "string");
}

/** Resolve a language model from a provider instance (`languageModel(id)`) or a factory function `(id) => model`. */
export function languageModelFrom(exp: unknown, modelId: string, exportName = "export"): LanguageModel {
  const p = exp as SdkProviderLike;
  let model: unknown;
  if ((typeof exp === "object" || typeof exp === "function") && exp !== null && typeof p.languageModel === "function") model = p.languageModel(modelId);
  else if (typeof exp === "function") model = (exp as (id: string) => unknown)(modelId);
  else throw new AiConfigError(`${exportName} is neither an AI SDK provider nor a model factory function.`);
  if (!isModelLike(model)) throw new AiConfigError(`${exportName} did not return an AI SDK language model for CEREBRO_AI_MODEL.`);
  return model as LanguageModel;
}

/** Resolve an embedding model from a provider instance (`embeddingModel(id)` or `textEmbeddingModel(id)`). */
export function embeddingModelFrom(exp: unknown, modelId: string, exportName = "export"): EmbeddingModel {
  const p = exp as SdkProviderLike;
  const fn = typeof p?.embeddingModel === "function" ? p.embeddingModel : typeof p?.textEmbeddingModel === "function" ? p.textEmbeddingModel : undefined;
  if (!fn) throw new AiConfigError(`${exportName} has no embeddingModel(id) method, so CEREBRO_EMBEDDINGS=ai-sdk cannot use it.`);
  const model = fn.call(exp, modelId);
  if (!isModelLike(model)) throw new AiConfigError(`${exportName} did not return an AI SDK embedding model for CEREBRO_AI_EMBEDDING_MODEL.`);
  return model as EmbeddingModel;
}

export interface AiSetup {
  config: AiEnvConfig;
  /** Every configured provider; the deterministic provider is always present as the local fallback. */
  providers: AiProvider[];
  registry: ProviderRegistry;
  /** Null when embeddings are off (`CEREBRO_EMBEDDINGS=none`). */
  embeddings: EmbeddingProvider | null;
}

/**
 * Build providers from the environment. Fails fast with {@link AiConfigError}
 * when the configuration is incomplete or the named module cannot be loaded,
 * so a misconfigured server does not start silently on the wrong provider.
 */
export async function createAiFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { importer?: ModuleImporter } = {}): Promise<AiSetup> {
  const config = readAiEnv(env);
  const importer = deps.importer ?? importAiModule;
  const local = new DeterministicProvider();
  const providers: AiProvider[] = [];
  let exp: unknown;
  if (config.provider === "ai-sdk" || config.embeddings === "ai-sdk") exp = await loadSdkExport(config, importer);
  const exportName = `${config.sdkModule ?? ""}#${config.sdkExport}`;

  if (config.provider === "ai-sdk") {
    providers.push(new AiSdkProvider({ id: config.providerId, model: languageModelFrom(exp, config.model!, exportName), modelLabel: config.model! }));
  }
  providers.push(local);

  let embeddings: EmbeddingProvider | null = null;
  if (config.embeddings === "local") embeddings = new HashedEmbeddingProvider();
  else if (config.embeddings === "ai-sdk") {
    embeddings = new AiSdkEmbeddingProvider({
      id: config.providerId,
      model: embeddingModelFrom(exp, config.embeddingModel!, exportName),
      modelLabel: config.embeddingModel!,
      dimensions: config.embeddingDimensions!,
    });
  }

  return { config, providers, registry: new ProviderRegistry({ providers, defaultRoute: providers.map((p) => p.id) }), embeddings };
}

/** Safe summary for start-up logs: kinds, ids and model labels only. */
export function describeAiSetup(setup: AiSetup): Record<string, string | number | null> {
  return {
    provider: setup.config.provider,
    providers: setup.providers.map((p) => `${p.id}:${p.model}`).join(","),
    embeddings: setup.embeddings ? `${setup.embeddings.id}:${setup.embeddings.model}:${setup.embeddings.dimensions}` : null,
    retrievalMode: setup.config.retrievalMode,
  };
}
