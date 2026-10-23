import { describe, expect, it } from "vitest";
import { MockEmbeddingModelV4 } from "ai/test";
import {
  AiError,
  AiSdkEmbeddingProvider,
  cosine,
  HASHED_EMBEDDING_DIMENSIONS,
  HASHED_EMBEDDING_MODEL,
  HashedEmbeddingProvider,
  hashedEmbedding,
  reciprocalRankFusion,
} from "./index";

describe("hashed local embeddings", () => {
  it("is deterministic, unit length and of the configured dimension", () => {
    const a = hashedEmbedding("Mid-market net revenue retention was 124%.");
    const b = hashedEmbedding("Mid-market net revenue retention was 124%.");
    expect(a).toEqual(b);
    expect(a).toHaveLength(HASHED_EMBEDDING_DIMENSIONS);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("scores lexically related text above unrelated text", () => {
    const q = hashedEmbedding("What is the retention of mid-market customers?");
    const related = hashedEmbedding("Mid-market customers show the strongest retention and expansion.");
    const unrelated = hashedEmbedding("Nominate pod members from product and sales.");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });

  it("returns a zero vector for text without content terms", () => {
    expect(hashedEmbedding("the of and").every((x) => x === 0)).toBe(true);
  });

  it("provider reports a local model label and embeds batches", async () => {
    const p = new HashedEmbeddingProvider();
    expect(p).toMatchObject({ id: "deterministic", model: HASHED_EMBEDDING_MODEL, dimensions: 256, external: false });
    const res = await p.embed(["a cost estimate", "a risk"], { timeoutMs: 1000 });
    expect(res.embeddings).toHaveLength(2);
    expect(new HashedEmbeddingProvider({ dimensions: 64 }).model).toBe(`${HASHED_EMBEDDING_MODEL}-64`);
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards ids ranked well in both lists and keeps order deterministic", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["c", "a", "d"],
    ]);
    expect(fused.map((x) => x.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
  });

  it("never adds ids it was not given", () => {
    expect(reciprocalRankFusion([[], ["x"]]).map((x) => x.id)).toEqual(["x"]);
  });
});

describe("AiSdkEmbeddingProvider (injected model)", () => {
  const model = (dims: number) =>
    new MockEmbeddingModelV4({
      modelId: "mock-embed",
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => new Array(dims).fill(0.5)), warnings: [] }),
    });

  it("returns vectors of the configured dimension", async () => {
    const p = new AiSdkEmbeddingProvider({ id: "vendor_a", model: model(4), dimensions: 4 });
    const res = await p.embed(["one", "two"], { timeoutMs: 1000 });
    expect(res.embeddings).toEqual([
      [0.5, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ]);
    expect(p.model).toBe("mock-embed");
  });

  it("fails with invalid_output when dimensions differ from configuration", async () => {
    const p = new AiSdkEmbeddingProvider({ id: "vendor_a", model: model(3), dimensions: 4 });
    await expect(p.embed(["one"], { timeoutMs: 1000 })).rejects.toMatchObject({ category: "invalid_output" });
  });

  it("classifies a provider failure without leaking input", async () => {
    const failing = new MockEmbeddingModelV4({
      doEmbed: async () => {
        throw new Error("boom: secret input text");
      },
    });
    const p = new AiSdkEmbeddingProvider({ id: "vendor_a", model: failing, dimensions: 4 });
    const err = await p.embed(["secret input text"], { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).category).toBe("provider_error");
    expect((err as AiError).message).not.toContain("secret");
  });
});
