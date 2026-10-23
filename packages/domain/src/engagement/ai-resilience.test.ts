/**
 * Principle 6 (reading never depends on a live model) and W3.2 (embeddings
 * and hybrid retrieval) against a real migrated database.
 */
import {
  AiError,
  DeterministicProvider,
  HashedEmbeddingProvider,
  hashedEmbedding,
  ProviderRegistry,
  type AiProvider,
  type EmbeddingProvider,
} from "@cerebro/ai";
import { aiRuns, jobs, organizations, retrievalChunks, withSystemContext } from "@cerebro/database";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDraft, getRevisionDocument, updateDraft } from "../briefings/index";
import { drainJobs } from "./test-fixtures";
import { createPreview, publishBriefing, withdrawPublication } from "../publication/index";
import { makePublished } from "../publication/test-utils";
import { createTestWorld, type TestWorld } from "../testing";
import { askQuestion, retrieveRevisionChunks, setAiRegistry, setAiRuntime } from "./index";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  setAiRuntime(undefined);
  await w.h.close();
});

const QUESTION = "What net revenue retention did mid-market accounts record?";
const sys = <T>(fn: Parameters<typeof withSystemContext<T>>[1]) => withSystemContext(w.h.db, fn);

function provider(id: string, run: AiProvider["run"]): AiProvider {
  return { id, model: `${id}-model`, external: true, supports: () => true, run };
}
const failing = (id = "vendor_x") =>
  provider(id, async () => {
    throw new AiError("unavailable", "provider outage");
  });
const hanging = (id = "vendor_slow") => provider(id, () => new Promise(() => {}));

async function allowProviders(ids: string[]) {
  await sys((tx) => tx.update(organizations).set({ settings: { ai: { allowedProviders: ids } } }).where(eq(organizations.id, w.seed.orgs.acme.id)));
}

async function published() {
  const p = await makePublished(w);
  await drainJobs(w);
  return p;
}

describe("provider outage (principle 6)", () => {
  it("answers honestly as unavailable while reading, editing and publishing keep working", async () => {
    const p = await published();
    await allowProviders(["vendor_x"]);
    setAiRegistry(new ProviderRegistry({ providers: [failing()] }));

    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("failed");
    expect(res.parts).toEqual([]);
    expect(res.citations).toEqual([]);
    expect(res.missing).toMatch(/Answers are unavailable right now/);
    const runs = await sys((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "answer")));
    expect(runs.map((r) => [r.provider, r.status, r.errorCategory])).toEqual([["vendor_x", "failed", "unavailable"]]);

    // Reading.
    const doc = await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId: p.briefingId });
    expect(doc.revision.revisionNumber).toBe(1);
    // Manual editing.
    const draft = await getDraft(w.h.db, p.ctx, p.briefingId);
    const edited = await updateDraft(w.h.db, p.ctx, {
      briefingId: p.briefingId,
      expectedVersion: draft.lockVersion,
      document: { ...draft.document, position: { ...draft.document.position, headline: "Edited during an outage" } },
    });
    // Publishing.
    const preview = await createPreview(w.h.db, p.ctx, { briefingId: p.briefingId });
    const pub = await publishBriefing(w.h.db, p.ctx, { briefingId: p.briefingId, previewId: preview.previewId });
    expect(pub.revisionNumber).toBe(2);
    expect(edited.draftVersion).toBeGreaterThan(draft.lockVersion);
  });

  it("falls back to the local deterministic provider when the organization allows it", async () => {
    const p = await published();
    await allowProviders(["vendor_x", "deterministic"]);
    setAiRegistry(new ProviderRegistry({ providers: [failing(), new DeterministicProvider()] }));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
    expect(res.citations.length).toBeGreaterThan(0);
    const runs = await sys((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "answer")).orderBy(aiRuns.createdAt));
    expect(runs.map((r) => [r.provider, r.status])).toEqual([
      ["vendor_x", "failed"],
      ["deterministic", "succeeded"],
    ]);
  });

  it("times out a hanging provider and falls back", async () => {
    const p = await published();
    await allowProviders(["vendor_slow", "deterministic"]);
    setAiRegistry(new ProviderRegistry({ providers: [hanging(), new DeterministicProvider()] }));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION }, { timeoutMs: 50 });
    expect(res.status).toBe("answered");
    const runs = await sys((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "answer")));
    expect(runs.find((r) => r.provider === "vendor_slow")?.errorCategory).toBe("timeout");
  });

  it("never falls back to a provider the organization has not approved", async () => {
    const p = await published();
    await allowProviders(["vendor_x"]);
    setAiRegistry(new ProviderRegistry({ providers: [failing(), new DeterministicProvider()] }));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("failed");
  });
});

describe("embeddings (W3.2)", () => {
  const local = () => new HashedEmbeddingProvider();

  it("embeds only the published revision's retrieval chunks, with model and dimensions recorded", async () => {
    setAiRuntime({ embeddings: local() });
    const p = await published();
    const chunks = await sys((tx) => tx.select().from(retrievalChunks).where(eq(retrievalChunks.revisionId, p.pub.revisionId)));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.embeddingModel).toBe("hashed-bow-v1");
      expect(c.embeddingDims).toBe(256);
      expect(c.embedding).toHaveLength(256);
      expect(c.embedding).toEqual(hashedEmbedding(c.text).map((x) => expect.closeTo(x, 5)));
    }
    // Private source chunks are never embedded by this job.
    const sourceVectors = await sys((tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from source_chunks where embedding is not null`));
    expect(sourceVectors.rows[0]!.n).toBe(0);
    const [job] = await sys((tx) => tx.select().from(jobs).where(eq(jobs.kind, "embed_revision")));
    expect(job).toMatchObject({ status: "succeeded" });
  });

  it("enqueues nothing when embeddings are off or the organization has not allowed the provider", async () => {
    const p = await published();
    expect(await sys((tx) => tx.select().from(jobs).where(eq(jobs.kind, "embed_revision")))).toHaveLength(0);
    expect(await sys((tx) => tx.select().from(retrievalChunks).where(isNotNull(retrievalChunks.embedding)))).toHaveLength(0);

    const external: EmbeddingProvider = { id: "vendor_e", model: "e1", dimensions: 3, external: true, embed: async () => ({ embeddings: [] }) };
    setAiRuntime({ embeddings: external });
    const draft = await getDraft(w.h.db, p.ctx, p.briefingId);
    await updateDraft(w.h.db, p.ctx, { briefingId: p.briefingId, expectedVersion: draft.lockVersion, document: { ...draft.document, title: "v2" } });
    const preview = await createPreview(w.h.db, p.ctx, { briefingId: p.briefingId });
    await publishBriefing(w.h.db, p.ctx, { briefingId: p.briefingId, previewId: preview.previewId });
    await drainJobs(w);
    expect(await sys((tx) => tx.select().from(jobs).where(eq(jobs.kind, "embed_revision")))).toHaveLength(0);
  });

  it("an embedding outage fails only the embedding job; questions still answer from full-text", async () => {
    const down: EmbeddingProvider = {
      id: "deterministic",
      model: "down",
      dimensions: 8,
      external: false,
      embed: async () => {
        throw new AiError("unavailable", "embedding outage");
      },
    };
    setAiRuntime({ embeddings: down, retrievalMode: "hybrid" });
    const p = await published();
    const [job] = await sys((tx) => tx.select().from(jobs).where(eq(jobs.kind, "embed_revision")));
    expect(job).toMatchObject({ lastErrorCategory: "embed_unavailable" });
    expect(job!.status).not.toBe("succeeded");
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
  });

  it("does not embed a withdrawn revision", async () => {
    setAiRuntime({ embeddings: local() });
    const p = await makePublished(w);
    await withdrawPublication(w.h.db, p.ctx, { briefingId: p.briefingId, publicationId: p.pub.publicationId });
    await drainJobs(w);
    expect(await sys((tx) => tx.select().from(retrievalChunks).where(isNotNull(retrievalChunks.embedding)))).toHaveLength(0);
  });
});

describe("hybrid retrieval", () => {
  it("fuses full-text and vector rankings within the revision only", async () => {
    setAiRuntime({ embeddings: new HashedEmbeddingProvider(), retrievalMode: "hybrid" });
    const a = await published();
    const b = await published();
    const q = "How long until mid-market accounts reach first value?";
    const vector = hashedEmbedding(q);
    const run = (mode: "fts" | "hybrid", model = "hashed-bow-v1") =>
      sys((tx) =>
        retrieveRevisionChunks(tx, w.seed.orgs.acme.id, a.pub.revisionId, q, { mode, queryEmbedding: { vector, model, dimensions: 256 } }),
      );
    const fts = await run("fts");
    const hybrid = await run("hybrid");
    expect(hybrid.every((c) => c.passage.revisionId === a.pub.revisionId)).toBe(true);
    const all = await sys((tx) => tx.select({ id: retrievalChunks.id }).from(retrievalChunks).where(eq(retrievalChunks.revisionId, a.pub.revisionId)));
    expect(hybrid).toHaveLength(Math.min(24, all.length));
    expect(fts).toHaveLength(hybrid.length);
    // Ranked 2nd by full-text and 1st by vector, it ties for first under fusion.
    expect(hybrid.slice(0, 2).map((c) => c.passage.id)).toContain("blk_ev_time_to_value");
    // A vector from another model never matches stored vectors: hybrid degrades to full-text.
    expect((await run("hybrid", "other-model")).map((c) => c.passage.id)).toEqual(fts.map((c) => c.passage.id));
    expect(b.pub.revisionId).not.toBe(a.pub.revisionId);

    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: a.briefingId, question: q });
    expect(res.status).toBe("answered");
    expect(res.revisionNumber).toBe(1);
  });

  it("stays on full-text when the embedding provider is not allowed for the organization", async () => {
    let calls = 0;
    const external: EmbeddingProvider = {
      id: "vendor_e",
      model: "e1",
      dimensions: 3,
      external: true,
      embed: async (texts) => {
        calls++;
        return { embeddings: texts.map(() => [1, 0, 0]) };
      },
    };
    setAiRuntime({ embeddings: external, retrievalMode: "hybrid" });
    const p = await published();
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
    expect(calls).toBe(0);
    const embedded = await sys((tx) =>
      tx.select().from(retrievalChunks).where(and(eq(retrievalChunks.revisionId, p.pub.revisionId), isNotNull(retrievalChunks.embedding))),
    );
    expect(embedded).toHaveLength(0);
  });
});
