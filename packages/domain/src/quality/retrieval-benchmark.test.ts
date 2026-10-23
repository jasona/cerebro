import { describe, expect, it } from "vitest";
import { RETRIEVAL_QUERIES, evaluateRetrieval } from "./retrieval-benchmark";

describe("retrieval evaluation harness", () => {
  it("ranks every labelled query in both modes over the embedded fixture", async () => {
    const r = await evaluateRetrieval();
    expect(r.embedding).toMatchObject({ provider: "deterministic", model: "hashed-bow-v1", source: "local-default" });
    expect(r.corpus.chunks).toBeGreaterThan(0);
    expect(r.corpus.embeddedChunks).toBe(r.corpus.chunks);
    expect(r.embeddingFailures).toEqual([]);
    for (const mode of ["fts", "hybrid"] as const) {
      const m = r.metrics[mode];
      expect(m.queries).toBe(RETRIEVAL_QUERIES.length);
      for (const v of [m.hitAt1, m.recallAt3, m.recallAt5, m.mrr]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [m.hitAt1, m.recallAt3, m.recallAt5, m.mrr]) expect(v).toBeLessThanOrEqual(1);
    }
    // Labels refer to passages that exist in the corpus.
    const seen = new Set(r.perQuery.flatMap((q) => [...q.fts, ...q.hybrid]));
    for (const q of RETRIEVAL_QUERIES) for (const id of q.relevant) expect(seen.has(id), id).toBe(true);
  });
});
