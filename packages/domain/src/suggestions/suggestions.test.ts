import {
  DeterministicProvider,
  ProviderRegistry,
  type AiProvider,
  type AiTask,
  type ProviderResult,
  type TaskInput,
  type TaskOutput,
} from "@cerebro/ai";
import { aiRuns, auditEvents, briefingRevisions, briefingSuggestions, organizations, withSystemContext } from "@cerebro/database";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDraft, updateDraft } from "../briefings/index";
import { setAiRegistry, setAiRuntime } from "../engagement/ai-runtime";
import { DomainError } from "../errors";
import { createPreview, publishBriefing } from "../publication/index";
import { makeDraft, makePublished } from "../publication/test-utils";
import { createTestWorld, type TestWorld } from "../testing";
import {
  acceptSuggestion,
  dismissSuggestion,
  listSuggestions,
  requestPerspectiveSuggestions,
  requestRevisionProposal,
} from "./index";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  setAiRuntime(undefined);
  await w.h.close();
});

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
const sys = <T>(fn: Parameters<typeof withSystemContext<T>>[1]) => withSystemContext(w.h.db, fn);

/** A provider that returns a fixed output for one task (or throws). */
function fakeProvider(id: string, output: unknown | (() => never), external = true): AiProvider {
  return {
    id,
    model: `${id}-model`,
    external,
    supports: () => true,
    async run<T extends AiTask>(_task: T, _input: TaskInput<T>): Promise<ProviderResult<TaskOutput<T>>> {
      const out = typeof output === "function" ? (output as () => never)() : output;
      return { output: out as TaskOutput<T>, usage: {}, latencyMs: 1, provider: id, model: `${id}-model` };
    },
  };
}

async function allowProviders(ids: string[]) {
  await sys((tx) => tx.update(organizations).set({ settings: { ai: { allowedProviders: ids } } }).where(eq(organizations.id, w.seed.orgs.acme.id)));
}

describe("AI usage limits", () => {
  it("over the organization's limit, suggestions behave as during an outage: no provider call", async () => {
    const d = await makeDraft(w);
    let calls = 0;
    const counting = fakeProvider("counting", () => {
      calls++;
      throw new Error("must not be called");
    });
    setAiRegistry(new ProviderRegistry({ providers: [counting] }));
    await sys((tx) =>
      tx
        .update(organizations)
        .set({ settings: { ai: { allowedProviders: ["counting"], usageLimits: { runs: "0/3600" } } } })
        .where(eq(organizations.id, w.seed.orgs.acme.id)),
    );
    const res = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(calls).toBe(0);
    expect(res.status).not.toBe("suggested");
    expect(res.suggestions).toEqual([]);
  });
});

describe("perspective suggestions are proposals only (principle 2)", () => {
  it("stores labelled suggestions without touching the draft or any publication", async () => {
    const d = await makePublished(w);
    const before = await getDraft(w.h.db, d.ctx, d.briefingId);
    const res = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });

    expect(res.status).toBe("suggested");
    expect(res.suggestions.map((s) => s.perspective?.label)).toEqual(["Decision makers", "Risk review", "Delivery"]);
    expect(res.suggestions.every((s) => s.provider === "deterministic" && s.model === "deterministic-v1" && s.status === "pending")).toBe(true);
    expect(res.suggestions[0]!.baseVersion).toBe(before.lockVersion);

    const after = await getDraft(w.h.db, d.ctx, d.briefingId);
    expect(after.lockVersion).toBe(before.lockVersion);
    expect(after.document).toEqual(before.document);
    const revisions = await sys((tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.briefingId, d.briefingId)));
    expect(revisions).toHaveLength(1);
    expect(await listSuggestions(w.h.db, d.ctx, d.briefingId)).toHaveLength(3);

    // ai_runs records the run without content.
    const runs = await sys((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "suggest_perspectives")));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ provider: "deterministic", status: "succeeded", promptVersion: "suggest_perspectives.v1" });
  });

  it("does not repeat pending labels when asked again", async () => {
    const d = await makeDraft(w);
    await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    const again = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(again.suggestions.map((s) => s.perspective?.label)).toEqual(["Evidence review"]);
    expect(again.rejected).toBe(0);
  });

  it("accepts through the optimistic-concurrency save and only once", async () => {
    const d = await makeDraft(w);
    const { suggestions } = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    const delivery = suggestions.find((s) => s.perspective?.label === "Delivery")!;

    await expect(
      acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: delivery.id, expectedVersion: d.version - 1 }),
    ).rejects.toSatisfy((e: unknown) => isCode("conflict")(e) && (e as DomainError).details?.currentVersion === d.version);

    const res = await acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: delivery.id, expectedVersion: d.version });
    expect(res.draftVersion).toBe(d.version + 1);
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    const added = draft.document.perspectives.find((p) => p.label === "Delivery")!;
    expect(added).toMatchObject({ emphasis: ["sec_next_steps"], audience: "Teams delivering the plan" });

    await expect(
      acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: delivery.id, expectedVersion: res.draftVersion }),
    ).rejects.toSatisfy(isCode("conflict"));
    const [row] = await sys((tx) => tx.select().from(briefingSuggestions).where(eq(briefingSuggestions.id, delivery.id)));
    expect(row).toMatchObject({ status: "accepted", appliedVersion: res.draftVersion, decidedBy: w.seed.users.riley });
    expect((await listSuggestions(w.h.db, d.ctx, d.briefingId)).map((s) => s.id)).not.toContain(delivery.id);

    const audit = await sys((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "suggestion.accepted")));
    expect(audit).toHaveLength(1);
  });

  it("an accepted suggestion is published only by an explicit publish", async () => {
    const d = await makePublished(w);
    const { suggestions } = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    await acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: suggestions[0]!.id, expectedVersion: draft.lockVersion });
    const [current] = await sys((tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.briefingId, d.briefingId)));
    expect((current!.documentJson as { perspectives: { label: string }[] }).perspectives.map((p) => p.label)).toEqual(["Finance", "Operations"]);

    const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
    const pub = await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId });
    expect(pub.revisionNumber).toBe(2);
  });

  it("dismissing removes the suggestion and leaves the draft alone", async () => {
    const d = await makeDraft(w);
    const { suggestions } = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    await dismissSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: suggestions[1]!.id });
    expect((await listSuggestions(w.h.db, d.ctx, d.briefingId)).map((s) => s.id)).toEqual([suggestions[0]!.id, suggestions[2]!.id]);
    expect((await getDraft(w.h.db, d.ctx, d.briefingId)).lockVersion).toBe(d.version);
    await expect(dismissSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: suggestions[1]!.id })).rejects.toSatisfy(
      isCode("conflict"),
    );
  });

  it("re-validates on accept: a removed section blocks the suggestion", async () => {
    const d = await makeDraft(w);
    const { suggestions } = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    const delivery = suggestions.find((s) => s.perspective?.label === "Delivery")!;
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    const edited = await updateDraft(w.h.db, d.ctx, {
      briefingId: d.briefingId,
      expectedVersion: draft.lockVersion,
      document: { ...draft.document, sections: draft.document.sections.filter((s) => s.id !== "sec_next_steps") },
    });
    await expect(
      acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: delivery.id, expectedVersion: edited.draftVersion }),
    ).rejects.toSatisfy((e: unknown) => isCode("validation")(e) && ((e as DomainError).details?.reasons as string[]).includes("unknown_section"));
  });
});

describe("D06: suggested perspectives change emphasis only", () => {
  it("drops suggestions that reference missing sections, blocks or evidence, or state new numbers", async () => {
    const d = await makeDraft(w);
    const p = (label: string, extra: object) => ({
      perspective: { id: `psp_${label.toLowerCase()}0001`, label, summary: "Same facts, different emphasis.", emphasis: ["sec_tradeoffs"], implications: [], ...extra },
      rationale: "test",
    });
    setAiRegistry(
      new ProviderRegistry({
        providers: [
          fakeProvider(
            "deterministic",
            {
              suggestions: [
                p("Ghost", { emphasis: ["sec_does_not_exist"] }),
                p("Linker", { implications: [{ id: "itm_link0001", text: "See this.", blockIds: ["blk_missing01"] }] }),
                p("Inventor", { summary: "The pilot returns 3.5x its cost." }),
                p("Citer", { summary: "Supported by ev_made_up_one." }),
                p("Honest", {}),
              ],
            },
            false,
          ),
        ],
      }),
    );
    const res = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(res.suggestions.map((s) => s.perspective?.label)).toEqual(["Honest"]);
    expect(res.rejected).toBe(4);
    expect(res.notes).toMatch(/dropped/);
    const stored = await sys((tx) => tx.select().from(briefingSuggestions));
    expect(stored).toHaveLength(1);
  });
});

describe("authorization", () => {
  it("only draft collaborators with edit can request, list, accept or dismiss", async () => {
    const d = await makePublished(w);
    const { suggestions } = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    const alex = w.ctx("alex"); // company reader of the published brief
    await expect(requestPerspectiveSuggestions(w.h.db, alex, { briefingId: d.briefingId })).rejects.toSatisfy(
      (e: unknown) => isCode("not_found")(e) || isCode("forbidden")(e),
    );
    await expect(listSuggestions(w.h.db, alex, d.briefingId)).rejects.toSatisfy((e: unknown) => isCode("not_found")(e) || isCode("forbidden")(e));
    await expect(
      acceptSuggestion(w.h.db, alex, { briefingId: d.briefingId, suggestionId: suggestions[0]!.id, expectedVersion: d.version }),
    ).rejects.toSatisfy((e: unknown) => isCode("not_found")(e) || isCode("forbidden")(e));
    await expect(dismissSuggestion(w.h.db, alex, { briefingId: d.briefingId, suggestionId: suggestions[0]!.id })).rejects.toSatisfy(
      (e: unknown) => isCode("not_found")(e) || isCode("forbidden")(e),
    );
    // Another tenant sees nothing.
    await expect(listSuggestions(w.h.db, w.ctx("taylor", "globex"), d.briefingId)).rejects.toSatisfy(isCode("not_found"));
    // A suggestion id from one briefing cannot be decided through another.
    const other = await makeDraft(w);
    await expect(dismissSuggestion(w.h.db, d.ctx, { briefingId: other.briefingId, suggestionId: suggestions[0]!.id })).rejects.toSatisfy(
      isCode("not_found"),
    );
  });
});

describe("provider failure (principle 6)", () => {
  const failing = () => fakeProvider("vendor_x", () => {
    throw Object.assign(new Error("down"), {});
  });

  it("reports unavailable, stores nothing and leaves the draft editable", async () => {
    const d = await makeDraft(w);
    await allowProviders(["vendor_x"]);
    setAiRegistry(new ProviderRegistry({ providers: [failing()] }));
    const res = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(res).toMatchObject({ status: "unavailable", suggestions: [] });
    expect(await sys((tx) => tx.select().from(briefingSuggestions))).toHaveLength(0);
    const runs = await sys((tx) => tx.select().from(aiRuns).where(and(eq(aiRuns.task, "suggest_perspectives"), eq(aiRuns.status, "failed"))));
    expect(runs).toHaveLength(1);
    const proposal = await requestRevisionProposal(w.h.db, d.ctx, { briefingId: d.briefingId, instruction: "Add a perspective for the sales team" });
    expect(proposal.status).toBe("unavailable");

    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    await updateDraft(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: draft.lockVersion, document: { ...draft.document, title: "Edited offline" } });
  });

  it("falls back to the local provider when the organization allows it", async () => {
    const d = await makeDraft(w);
    await allowProviders(["vendor_x", "deterministic"]);
    setAiRegistry(new ProviderRegistry({ providers: [failing(), new DeterministicProvider()] }));
    const res = await requestPerspectiveSuggestions(w.h.db, d.ctx, { briefingId: d.briefingId });
    expect(res.status).toBe("suggested");
    expect(res.suggestions[0]!.provider).toBe("deterministic");
  });
});

describe("revision proposals", () => {
  it("stores a supported proposal and applies it only on accept, against the same draft version", async () => {
    const d = await makeDraft(w);
    const res = await requestRevisionProposal(w.h.db, d.ctx, { briefingId: d.briefingId, instruction: "Add a perspective for the sales team" });
    expect(res.status).toBe("suggested");
    expect(res.suggestion).toMatchObject({ kind: "revision", baseVersion: d.version, operations: [{ op: "add_perspective" }] });
    expect((await getDraft(w.h.db, d.ctx, d.briefingId)).lockVersion).toBe(d.version);

    const accepted = await acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: res.suggestion!.id, expectedVersion: d.version });
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    expect(accepted.draftVersion).toBe(d.version + 1);
    expect(draft.document.perspectives.map((p) => p.label)).toContain("Sales Team");
  });

  it("refuses to apply a proposal made against an older draft", async () => {
    const d = await makeDraft(w);
    const res = await requestRevisionProposal(w.h.db, d.ctx, { briefingId: d.briefingId, instruction: "Add a perspective for the board" });
    const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
    const edited = await updateDraft(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: draft.lockVersion, document: { ...draft.document, title: "Changed" } });
    await expect(
      acceptSuggestion(w.h.db, d.ctx, { briefingId: d.briefingId, suggestionId: res.suggestion!.id, expectedVersion: edited.draftVersion }),
    ).rejects.toSatisfy((e: unknown) => isCode("conflict")(e) && (e as DomainError).details?.reason === "suggestion_stale");
  });

  it("reports unsupported instructions honestly and stores nothing", async () => {
    const d = await makeDraft(w);
    const res = await requestRevisionProposal(w.h.db, d.ctx, { briefingId: d.briefingId, instruction: "Rewrite the stakes to be punchier" });
    expect(res.status).toBe("unsupported");
    expect(await sys((tx) => tx.select().from(briefingSuggestions))).toHaveLength(0);
  });

  it("rejects proposals that do not apply to the draft", async () => {
    const d = await makeDraft(w);
    setAiRegistry(
      new ProviderRegistry({
        providers: [
          fakeProvider(
            "deterministic",
            {
              status: "proposed",
              scope: "Removes a block",
              operations: [{ op: "remove_block", blockId: "blk_does_not_exist" }],
              gaps: [],
            },
            false,
          ),
        ],
      }),
    );
    const res = await requestRevisionProposal(w.h.db, d.ctx, { briefingId: d.briefingId, instruction: "Remove the missing block" });
    expect(res.status).toBe("rejected");
    expect(await sys((tx) => tx.select().from(briefingSuggestions))).toHaveLength(0);
  });
});
