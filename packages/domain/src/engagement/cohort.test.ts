/**
 * W3.6 regression: every author-facing count derived from private reader
 * questions is cohort-suppressed (D07), including the count of questions
 * withheld from topic summaries and the "new job created" signal of a topic
 * summary request. Tested at the boundary: 2 vs 3 distinct readers.
 */
import {
  ProviderRegistry,
  type AiProvider,
  type AiTask,
  type ProviderResult,
  type TaskInput,
  type TaskOutput,
} from "@cerebro/ai";
import type { SeedUserKey } from "@cerebro/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWorld, type TestWorld } from "../testing";
import { askQuestion, getAuthorFeedback, getEngagementSummary, requestTopicSummary, setAiRegistry } from "./index";
import { drainJobs, makePublishedBriefing, type FixtureBriefing } from "./test-fixtures";

let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  setAiRegistry(undefined);
  await w.h.close();
});

/** Topic provider that groups nothing, so every question is withheld. */
const noTopics: AiProvider = {
  id: "deterministic",
  model: "no-topics",
  external: false,
  supports: (task) => task === "summarize_topics",
  async run<T extends AiTask>(_task: T, _input: TaskInput<T>): Promise<ProviderResult<TaskOutput<T>>> {
    return { output: { topics: [], suppressedQuestions: 0 } as unknown as TaskOutput<T>, usage: {}, latencyMs: 0, provider: "deterministic", model: "no-topics" };
  },
};

async function briefingWithQuestions(readers: SeedUserKey[]): Promise<FixtureBriefing> {
  const fb = await makePublishedBriefing(w);
  await drainJobs(w);
  for (const r of readers) {
    // Two questions per reader: counts are not a proxy for readers.
    await askQuestion(w.h.db, w.ctx(r), { briefingId: fb.id, question: `Question one from ${r}?` });
    await askQuestion(w.h.db, w.ctx(r), { briefingId: fb.id, question: `Question two from ${r}?` });
  }
  setAiRegistry(new ProviderRegistry({ providers: [noTopics] }));
  await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id);
  await drainJobs(w);
  return fb;
}

describe("withheld-question count is cohort-suppressed (W3.6)", () => {
  it("is withheld when the withheld questions come from 2 readers", async () => {
    const fb = await briefingWithQuestions(["alex", "priya"]);
    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.topics).toEqual([]);
    expect(out.suppressedQuestionCount).toBeNull();
    expect(out.suppressedQuestionCountSuppressed).toBe(true);

    const summary = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(summary.topics).toMatchObject({ suppressedQuestionCount: null, suppressedQuestionCountSuppressed: true });
    expect(summary.revisions[0]!.measured).toMatchObject({ questionsAsked: null, questionsAskedSuppressed: true });
  });

  it("is shown when the withheld questions come from 3 readers", async () => {
    const fb = await briefingWithQuestions(["alex", "priya", "jordan"]);
    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.topics).toEqual([]);
    expect(out.suppressedQuestionCount).toBe(6);
    expect(out.suppressedQuestionCountSuppressed).toBe(false);

    const summary = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(summary.topics).toMatchObject({ suppressedQuestionCount: 6, suppressedQuestionCountSuppressed: false });
    expect(summary.revisions[0]!.measured).toMatchObject({ questionsAsked: 6, questionsAskedSuppressed: false });
  });

  it("an empty withheld bucket reads the same as a small cohort", async () => {
    const fb = await briefingWithQuestions([]);
    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.suppressedQuestionCount).toBeNull();
    expect(out.suppressedQuestionCountSuppressed).toBe(true);
  });
});

describe("topic summary requests do not signal small-cohort activity", () => {
  it("dedupes below 3 askers regardless of new questions, and re-runs from 3", async () => {
    const fb = await makePublishedBriefing(w);
    await drainJobs(w);
    const first = await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(first.created).toBe(true);
    await drainJobs(w);

    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: "What is the pilot budget?" });
    expect((await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id)).created).toBe(false);
    await askQuestion(w.h.db, w.ctx("priya"), { briefingId: fb.id, question: "Who approves the pilot?" });
    expect((await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id)).created).toBe(false);

    await askQuestion(w.h.db, w.ctx("jordan"), { briefingId: fb.id, question: "When does the pilot start?" });
    expect((await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id)).created).toBe(true);
  });
});
