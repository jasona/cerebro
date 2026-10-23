/**
 * Retrieval evaluation (W3.2): full-text vs hybrid ranking on the
 * representative strategy briefing, measured through the real indexing,
 * embedding and retrieval code on an in-memory PGlite database.
 *
 * Labels are hand-assigned passage ids (block keys, evidence keys, or the
 * position/context/request/perspective passages) for questions about the
 * fictional fixture. The set is small and lexical-leaning; it reports
 * numbers only and does not choose a default (T20: full-text stays the
 * default until measured and agreed). Not exported from the package index:
 * it is a harness for `npm run ai:eval` and tests.
 */
import { HashedEmbeddingProvider, type EmbeddingProvider } from "@cerebro/ai";
import { organizations, retrievalChunks, withSystemContext } from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { setAiRuntime } from "../engagement/ai-runtime";
import { embedQuestion, retrieveRevisionChunks } from "../engagement/retrieval";
import { drainJobs } from "../engagement/test-fixtures";
import { makePublished } from "../publication/test-utils";
import { createTestWorld } from "../testing";

export interface RetrievalQuery {
  id: string;
  question: string;
  /** Passage ids that answer the question. */
  relevant: readonly string[];
  /** "lexical": shares key words with the answer; "paraphrase": mostly different wording. */
  kind: "lexical" | "paraphrase";
}

export const RETRIEVAL_QUERIES: readonly RetrievalQuery[] = [
  { id: "nrr", kind: "lexical", question: "What net revenue retention did mid-market accounts record?", relevant: ["blk_ev_nrr_metric", "ev_cohort_q3", "blk_why_nrr_chart"] },
  { id: "time_to_value", kind: "lexical", question: "How long does it take mid-market accounts to reach first value?", relevant: ["blk_ev_time_to_value", "ev_implementation_review"] },
  { id: "deal_speed", kind: "lexical", question: "How quickly do mid-market deals close?", relevant: ["blk_ev_sales_cycle", "ev_pipeline_review"] },
  { id: "support_capacity", kind: "lexical", question: "How many additional accounts can the support team onboard per quarter?", relevant: ["ev_support_capacity", "blk_risk_capacity"] },
  { id: "request", kind: "lexical", question: "What decision is being requested?", relevant: ["request", "blk_rec_decision"] },
  { id: "criteria_owner", kind: "lexical", question: "Who drafts the stop-or-scale criteria?", relevant: ["blk_action_criteria"] },
  { id: "deferred", kind: "lexical", question: "Which roadmap items move out to staff the pod?", relevant: ["blk_tradeoff_defer"] },
  { id: "day90", kind: "lexical", question: "What happens at the day-90 review?", relevant: ["blk_next_timeline", "blk_rec_narrative"] },
  { id: "options", kind: "lexical", question: "Which options were considered besides the pilot?", relevant: ["blk_rec_decision", "blk_tradeoff_options"] },
  { id: "pricing", kind: "lexical", question: "Are current pricing tiers acceptable to mid-market buyers?", relevant: ["blk_assumption_pricing", "open_questions"] },
  { id: "finance_view", kind: "lexical", question: "What does finance leadership need to know?", relevant: ["psp_finance"] },
  { id: "capacity_risk", kind: "lexical", question: "What is the risk to support capacity during onboarding?", relevant: ["blk_risk_capacity", "ev_support_capacity"] },
  { id: "budget_exposure", kind: "paraphrase", question: "How much money are we putting at risk?", relevant: ["psp_finance", "blk_action_budget", "blk_tradeoff_options"] },
  { id: "who_staffs", kind: "paraphrase", question: "Who will be on the team running this?", relevant: ["blk_action_pod", "blk_rec_narrative"] },
  { id: "why_now", kind: "paraphrase", question: "Why should we act this quarter instead of later?", relevant: ["context", "blk_why_retention", "position"] },
  { id: "bigger_customers_value", kind: "paraphrase", question: "Do bigger customers get results faster than the largest ones?", relevant: ["blk_ev_time_to_value", "ev_implementation_review"] },
  { id: "growth_segment", kind: "paraphrase", question: "Which customer group grows its spend the most?", relevant: ["blk_why_retention", "blk_why_nrr_chart", "blk_ev_nrr_metric", "ev_cohort_q3"] },
  { id: "security_friction", kind: "paraphrase", question: "Do security questionnaires slow down sales?", relevant: ["blk_ev_sales_cycle", "ev_pipeline_review"] },
];

export interface RankMetrics {
  queries: number;
  /** Share of queries whose first result is relevant. */
  hitAt1: number;
  /** Mean share of relevant passages found in the top 3 / top 5. */
  recallAt3: number;
  recallAt5: number;
  /** Mean reciprocal rank of the first relevant passage (0 when none in the returned list). */
  mrr: number;
}

export interface RetrievalEvalReport {
  corpus: { name: string; chunks: number; embeddedChunks: number };
  embedding: { provider: string; model: string; dimensions: number; source: "configured" | "local-default" };
  topK: number;
  metrics: Record<"fts" | "hybrid", RankMetrics & { byKind: Record<RetrievalQuery["kind"], RankMetrics> }>;
  /** Questions whose embedding failed (hybrid fell back to full-text for them). */
  embeddingFailures: string[];
  perQuery: { id: string; kind: RetrievalQuery["kind"]; fts: string[]; hybrid: string[]; relevant: readonly string[] }[];
}

function metricsFor(rows: { ranked: string[]; relevant: readonly string[] }[]): RankMetrics {
  const n = rows.length || 1;
  let hit1 = 0;
  let r3 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const { ranked, relevant } of rows) {
    const rel = new Set(relevant);
    if (rel.has(ranked[0] ?? "")) hit1++;
    r3 += ranked.slice(0, 3).filter((id) => rel.has(id)).length / rel.size;
    r5 += ranked.slice(0, 5).filter((id) => rel.has(id)).length / rel.size;
    const first = ranked.findIndex((id) => rel.has(id));
    mrr += first >= 0 ? 1 / (first + 1) : 0;
  }
  const r = (x: number) => Math.round((x / n) * 1000) / 1000;
  return { queries: rows.length, hitAt1: r(hit1), recallAt3: r(r3), recallAt5: r(r5), mrr: r(mrr) };
}

/**
 * Publish the strategy briefing into a fresh in-memory database, index and
 * embed it with `embeddings` (the configured provider, or the local hashed
 * one), then rank every labelled query in both modes.
 */
export async function evaluateRetrieval(opts: { embeddings?: EmbeddingProvider | null; topK?: number } = {}): Promise<RetrievalEvalReport> {
  const configured = opts.embeddings ?? null;
  const embeddings = configured ?? new HashedEmbeddingProvider();
  const topK = opts.topK ?? 10;
  const w = await createTestWorld();
  try {
    await withSystemContext(w.h.db, (tx) =>
      tx
        .update(organizations)
        .set({ settings: { ai: { allowedProviders: [...new Set(["deterministic", embeddings.id])] } } })
        .where(eq(organizations.id, w.seed.orgs.acme.id)),
    );
    setAiRuntime({ embeddings, retrievalMode: "hybrid" });
    const p = await makePublished(w);
    await drainJobs(w);
    const revisionId = p.pub.revisionId;
    const orgId = w.seed.orgs.acme.id;

    const [counts] = await withSystemContext(w.h.db, (tx) =>
      tx
        .select({
          chunks: sql<number>`count(*)::int`,
          embedded: sql<number>`count(${retrievalChunks.embedding})::int`,
        })
        .from(retrievalChunks)
        .where(eq(retrievalChunks.revisionId, revisionId)),
    );

    const perQuery: RetrievalEvalReport["perQuery"] = [];
    const embeddingFailures: string[] = [];
    for (const q of RETRIEVAL_QUERIES) {
      const qe = await embedQuestion(embeddings, q.question);
      if (!qe) embeddingFailures.push(q.id);
      const rank = (mode: "fts" | "hybrid") =>
        withSystemContext(w.h.db, (tx) => retrieveRevisionChunks(tx, orgId, revisionId, q.question, { mode, queryEmbedding: qe, topK }));
      perQuery.push({
        id: q.id,
        kind: q.kind,
        relevant: q.relevant,
        fts: (await rank("fts")).map((c) => c.passage.id),
        hybrid: (await rank("hybrid")).map((c) => c.passage.id),
      });
    }

    const build = (mode: "fts" | "hybrid") => {
      const rows = (kind?: RetrievalQuery["kind"]) =>
        perQuery.filter((r) => !kind || r.kind === kind).map((r) => ({ ranked: r[mode], relevant: r.relevant }));
      return { ...metricsFor(rows()), byKind: { lexical: metricsFor(rows("lexical")), paraphrase: metricsFor(rows("paraphrase")) } };
    };

    return {
      corpus: { name: "strategyBriefing (fictional fixture)", chunks: counts?.chunks ?? 0, embeddedChunks: counts?.embedded ?? 0 },
      embedding: { provider: embeddings.id, model: embeddings.model, dimensions: embeddings.dimensions, source: configured ? "configured" : "local-default" },
      topK,
      metrics: { fts: build("fts"), hybrid: build("hybrid") },
      embeddingFailures,
      perQuery,
    };
  } finally {
    setAiRuntime(undefined);
    await w.h.close();
  }
}
