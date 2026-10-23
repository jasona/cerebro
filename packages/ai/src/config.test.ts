import { describe, expect, it } from "vitest";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { AiConfigError, createAiFromEnv, describeAiSetup, readAiEnv, type ModuleImporter } from "./index";

const lm = () => new MockLanguageModelV4({ modelId: "mock-model" });
const em = () =>
  new MockEmbeddingModelV4({
    modelId: "mock-embed",
    doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0]), warnings: [] }),
  });

/** A stand-in for an installed AI SDK provider package. */
const providerModule: Record<string, unknown> = {
  provider: Object.assign((id: string) => ({ ...lm(), modelId: id }), {
    languageModel: (id: string) => Object.assign(lm(), { modelId: id }),
    embeddingModel: () => em(),
  }),
  factory: (id: string) => Object.assign(lm(), { modelId: id }),
  notAProvider: 42,
};
const importer: ModuleImporter = async (spec) => {
  if (spec === "fake-provider") return providerModule;
  const err = new Error(`Cannot find package '${spec}'`) as Error & { code: string };
  err.code = "ERR_MODULE_NOT_FOUND";
  throw err;
};

describe("readAiEnv", () => {
  it("defaults to the deterministic provider, no embeddings and full-text retrieval", () => {
    expect(readAiEnv({})).toEqual({
      provider: "deterministic",
      providerId: "ai-sdk",
      sdkExport: "default",
      taskModels: {},
      taskEffort: {},
      refusalFallback: true,
      embeddings: "none",
      retrievalMode: "fts",
    });
  });

  it("rejects unknown values and incomplete ai-sdk configuration", () => {
    expect(() => readAiEnv({ CEREBRO_AI_PROVIDER: "vendor" })).toThrow(AiConfigError);
    expect(() => readAiEnv({ CEREBRO_RETRIEVAL_MODE: "vector" })).toThrow(/CEREBRO_RETRIEVAL_MODE/);
    expect(() => readAiEnv({ CEREBRO_AI_PROVIDER: "ai-sdk" })).toThrow(/CEREBRO_AI_SDK_MODULE is required/);
    expect(() => readAiEnv({ CEREBRO_AI_PROVIDER: "ai-sdk", CEREBRO_AI_SDK_MODULE: "x" })).toThrow(/CEREBRO_AI_MODEL is required/);
    expect(() => readAiEnv({ CEREBRO_EMBEDDINGS: "ai-sdk", CEREBRO_AI_SDK_MODULE: "x" })).toThrow(/EMBEDDING_MODEL and CEREBRO_AI_EMBEDDING_DIMENSIONS/);
    expect(() => readAiEnv({ CEREBRO_AI_PROVIDER_ID: "deterministic" })).toThrow(/CEREBRO_AI_PROVIDER_ID/);
  });
});

describe("createAiFromEnv", () => {
  it("builds only the local provider by default", async () => {
    const setup = await createAiFromEnv({}, { importer });
    expect(setup.providers.map((p) => p.id)).toEqual(["deterministic"]);
    expect(setup.embeddings).toBeNull();
    expect(setup.registry.resolve("answer", { allowedProviders: ["deterministic"] }).id).toBe("deterministic");
  });

  it("fails fast with a clear message when the named module is not installed", async () => {
    const env = { CEREBRO_AI_PROVIDER: "ai-sdk", CEREBRO_AI_SDK_MODULE: "not-installed", CEREBRO_AI_MODEL: "m1" };
    const err = await createAiFromEnv(env, { importer }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConfigError);
    expect((err as Error).message).toMatch(/CEREBRO_AI_SDK_MODULE="not-installed" could not be loaded \(ERR_MODULE_NOT_FOUND\)/);
    expect((err as Error).message).toMatch(/npm install/);
  });

  it("uses the default dynamic importer for a real missing package", async () => {
    const env = { CEREBRO_AI_PROVIDER: "ai-sdk", CEREBRO_AI_SDK_MODULE: "@cerebro/no-such-provider-package", CEREBRO_AI_MODEL: "m1" };
    await expect(createAiFromEnv(env)).rejects.toThrow(AiConfigError);
  });

  it("names the available exports when the configured export is missing", async () => {
    const env = { CEREBRO_AI_PROVIDER: "ai-sdk", CEREBRO_AI_SDK_MODULE: "fake-provider", CEREBRO_AI_MODEL: "m1" };
    await expect(createAiFromEnv(env, { importer })).rejects.toThrow(/no export "default" \(exports: provider, factory, notAProvider\)/);
    await expect(createAiFromEnv({ ...env, CEREBRO_AI_SDK_EXPORT: "notAProvider" }, { importer })).rejects.toThrow(/neither an AI SDK provider/);
  });

  it("wires an AI SDK provider instance ahead of the local fallback", async () => {
    const env = {
      CEREBRO_AI_PROVIDER: "ai-sdk",
      CEREBRO_AI_SDK_MODULE: "fake-provider",
      CEREBRO_AI_SDK_EXPORT: "provider",
      CEREBRO_AI_MODEL: "model-x",
      CEREBRO_AI_PROVIDER_ID: "approved_vendor",
    };
    const setup = await createAiFromEnv(env, { importer });
    expect(setup.providers.map((p) => [p.id, p.model])).toEqual([
      ["approved_vendor", "model-x"],
      ["deterministic", "deterministic-v1"],
    ]);
    // Org policy still decides: an org that has not approved the vendor only gets the local provider.
    expect(setup.registry.candidates("answer", { allowedProviders: ["deterministic"] }).map((p) => p.id)).toEqual(["deterministic"]);
    expect(setup.registry.candidates("answer", { allowedProviders: ["approved_vendor", "deterministic"] }).map((p) => p.id)).toEqual([
      "approved_vendor",
      "deterministic",
    ]);
    expect(describeAiSetup(setup)).toEqual({
      provider: "ai-sdk",
      providers: "approved_vendor:model-x,deterministic:deterministic-v1",
      embeddings: null,
      retrievalMode: "fts",
    });
  });

  it("accepts a plain factory function export", async () => {
    const env = { CEREBRO_AI_PROVIDER: "ai-sdk", CEREBRO_AI_SDK_MODULE: "fake-provider", CEREBRO_AI_SDK_EXPORT: "factory", CEREBRO_AI_MODEL: "m2" };
    const setup = await createAiFromEnv(env, { importer });
    expect(setup.providers[0]!.model).toBe("m2");
  });

  it("configures local or provider embeddings and the retrieval mode", async () => {
    const local = await createAiFromEnv({ CEREBRO_EMBEDDINGS: "local", CEREBRO_RETRIEVAL_MODE: "hybrid" }, { importer });
    expect(local.embeddings).toMatchObject({ id: "deterministic", model: "hashed-bow-v1", dimensions: 256 });
    expect(local.config.retrievalMode).toBe("hybrid");

    const remote = await createAiFromEnv(
      {
        CEREBRO_EMBEDDINGS: "ai-sdk",
        CEREBRO_AI_SDK_MODULE: "fake-provider",
        CEREBRO_AI_SDK_EXPORT: "provider",
        CEREBRO_AI_EMBEDDING_MODEL: "embed-1",
        CEREBRO_AI_EMBEDDING_DIMENSIONS: "3",
        CEREBRO_AI_PROVIDER_ID: "approved_vendor",
      },
      { importer },
    );
    expect(remote.providers.map((p) => p.id)).toEqual(["deterministic"]);
    expect(remote.embeddings).toMatchObject({ id: "approved_vendor", model: "embed-1", dimensions: 3, external: true });
    expect((await remote.embeddings!.embed(["x"], { timeoutMs: 1000 })).embeddings).toEqual([[1, 0, 0]]);
  });
});
