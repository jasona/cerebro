/**
 * Opt-in live check of every task against Claude (D12). Skipped unless
 * CEREBRO_AI_LIVE=1 and an Anthropic credential is set, so the normal suite
 * never touches the network. Run with `npm run ai:live`.
 *
 * It checks only that each task returns output valid against its schema with
 * the real structured-output request (the schemas, effort and refusal
 * fallback are accepted by the API). Quality is measured by `npm run ai:eval`;
 * no threshold is applied here. Only categories and counts are printed.
 */
import { describe, expect, it } from "vitest";
import { sampleHandoff, strategyBriefing } from "@cerebro/briefing-schema";
import {
  anthropicCredentialsPresent,
  createAiFromEnv,
  EVAL_REVISION_ID,
  LOCAL_PASSAGES,
  runTask,
  TASKS,
  TASK_NAMES,
  type AiTaskName,
  type AnthropicProvider,
} from "./index";

const live = process.env.CEREBRO_AI_LIVE === "1" && anthropicCredentialsPresent(process.env);

const inputs: Record<AiTaskName, unknown> = {
  answer: { question: "When are the legacy platforms retired?", revisionId: EVAL_REVISION_ID, passages: [...LOCAL_PASSAGES] },
  compose: { handoff: sampleHandoff, audience: "Executive team" },
  propose_revision: { document: strategyBriefing, instruction: "Make the position summary one sentence shorter without changing its meaning." },
  summarize_topics: {
    questions: [
      { id: "q1", text: "When does the migration start?", readerHash: "r1" },
      { id: "q2", text: "What is the migration timeline?", readerHash: "r2" },
      { id: "q3", text: "Who owns the budget?", readerHash: "r3" },
    ],
  },
  suggest_perspectives: { document: strategyBriefing, maxSuggestions: 2 },
};

describe.skipIf(!live)("Anthropic provider (live)", () => {
  it.each(TASK_NAMES)("%s returns schema-valid output", async (name) => {
    const setup = await createAiFromEnv({ ...process.env, CEREBRO_AI_PROVIDER: "anthropic" });
    const provider = setup.providers[0] as AnthropicProvider;
    const task = TASKS[name];
    const res = await runTask(provider, task, task.input.parse(inputs[name]) as never, { timeoutMs: 180_000 });
    console.log(
      `live task=${name} model=${res.record.model} status=${res.record.status} error=${res.record.errorCategory ?? "none"} ` +
        `latencyMs=${res.record.latencyMs} in=${res.record.usage.inputTokens ?? "?"} out=${res.record.usage.outputTokens ?? "?"} ` +
        `cacheRead=${res.record.usage.cacheReadInputTokens ?? "?"}`,
    );
    expect(res.ok).toBe(true);
  }, 200_000);
});
