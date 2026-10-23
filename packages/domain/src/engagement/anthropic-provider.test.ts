/**
 * The Anthropic provider (D12) through reader Q&A against a real migrated
 * database, with a fake SDK client at the module boundary (no network):
 * organization policy, outage fallback (principle 6), refusal as abstention,
 * and usage recording.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, DeterministicProvider, ProviderRegistry, type AnthropicMessagesClient } from "@cerebro/ai";
import { aiRuns, organizations, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePublished } from "../publication/test-utils";
import { createTestWorld, type TestWorld } from "../testing";
import { drainJobs } from "./test-fixtures";
import { askQuestion, setAiRuntime, setAiRegistry } from "./index";

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

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

function fake(respond: (prompt: string) => BetaMessage | Error) {
  let calls = 0;
  const client: AnthropicMessagesClient = {
    beta: {
      messages: {
        async create(body) {
          calls++;
          const r = respond(String(body.messages[0]!.content));
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { client, calls: () => calls };
}

function reply(stop: BetaMessage["stop_reason"], json?: unknown): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: json === undefined ? [] : [{ type: "text", text: JSON.stringify(json), citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, iterations: null },
  } as unknown as BetaMessage;
}

/** First passage the prompt offers, answered verbatim with its first sentence. */
function groundedAnswer(prompt: string) {
  const data = /<data name="passages">\n([\s\S]*?)\n<\/data>/.exec(prompt)![1]!;
  const passages = JSON.parse(data) as { id: string; text: string }[];
  const hit = passages.find((p) => /retention/i.test(p.text)) ?? passages[0]!;
  const sentence = hit.text.split(/(?<=\.)\s/)[0]!;
  return { status: "answered", answer: [{ text: sentence, kind: "stated", citations: [hit.id] }], citations: [{ passageId: hit.id }] };
}

async function allowProviders(ids: string[]) {
  await sys((tx) => tx.update(organizations).set({ settings: { ai: { allowedProviders: ids } } }).where(eq(organizations.id, w.seed.orgs.acme.id)));
}

async function published() {
  const p = await makePublished(w);
  await drainJobs(w);
  return p;
}

function registryWith(client: AnthropicMessagesClient) {
  return new ProviderRegistry({ providers: [new AnthropicProvider({ client }), new DeterministicProvider()] });
}

const answerRuns = () => sys((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "answer")).orderBy(aiRuns.createdAt));

describe("Anthropic provider in reader Q&A", () => {
  it("sends nothing to Anthropic until the organization allows it", async () => {
    const p = await published();
    const f = fake((prompt) => reply("end_turn", groundedAnswer(prompt)));
    setAiRegistry(registryWith(f.client));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
    expect(f.calls()).toBe(0);
    expect((await answerRuns()).map((r) => r.provider)).toEqual(["deterministic"]);
  });

  it("answers through Claude when allowed and records tokens including cache reads", async () => {
    const p = await published();
    await allowProviders(["anthropic", "deterministic"]);
    const f = fake((prompt) => reply("end_turn", groundedAnswer(prompt)));
    setAiRegistry(registryWith(f.client));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
    expect(res.citations.length).toBeGreaterThan(0);
    const runs = await answerRuns();
    expect(runs.map((r) => [r.provider, r.model, r.status, r.inputTokens, r.outputTokens])).toEqual([
      ["anthropic", "claude-opus-5-5", "succeeded", 1100, 60],
    ]);
  });

  it("falls back to the deterministic provider when Claude is overloaded", async () => {
    const p = await published();
    await allowProviders(["anthropic", "deterministic"]);
    const f = fake(() => new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers()));
    setAiRegistry(registryWith(f.client));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("answered");
    expect((await answerRuns()).map((r) => [r.provider, r.status, r.errorCategory])).toEqual([
      ["anthropic", "failed", "unavailable"],
      ["deterministic", "succeeded", null],
    ]);
  });

  it("answers honestly as unavailable when Anthropic is the only approved provider and is down", async () => {
    const p = await published();
    await allowProviders(["anthropic"]);
    const f = fake(() => new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers()));
    setAiRegistry(registryWith(f.client));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("failed");
    expect(res.missing).toMatch(/Answers are unavailable right now/);
  });

  it("stores a model refusal as an abstention, not a failure", async () => {
    const p = await published();
    await allowProviders(["anthropic", "deterministic"]);
    const f = fake(() => reply("refusal"));
    setAiRegistry(registryWith(f.client));
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: QUESTION });
    expect(res.status).toBe("refused");
    expect(res.parts).toEqual([]);
    expect(res.citations).toEqual([]);
    expect((await answerRuns()).map((r) => [r.provider, r.status])).toEqual([["anthropic", "abstained"]]);
  });
});
