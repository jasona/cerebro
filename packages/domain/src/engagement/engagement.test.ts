import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerCitations,
  briefingRevisions,
  organizations,
  qaThreads,
  retrievalChunks,
  revisionEvidence,
  withAuthContext,
  withSystemContext,
} from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canReadRevision } from "../access/index";
import { DomainError } from "../errors";
import { addSource, createEvidenceFromChunk, getSourceExtraction, LocalSourceStore, setSourceStore } from "../sources/index";
import { createTestWorld, type TestWorld } from "../testing";
import {
  askQuestion,
  getAuthorFeedback,
  getEngagementSummary,
  getMyThreads,
  listSubmittedFeedback,
  recordEngagementEvent,
  requestTopicSummary,
  resolveFeedback,
  submitFeedback,
} from "./index";
import { drainJobs, makePublishedBriefing, publishRevision, type FixtureBriefing } from "./test-fixtures";

let w: TestWorld;
let objects: string;

beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-objects-"));
  setSourceStore(new LocalSourceStore(objects));
});
afterEach(async () => {
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

const NRR_QUESTION = "What net revenue retention did mid-market accounts record?";

async function indexedBriefing(): Promise<FixtureBriefing> {
  const fb = await makePublishedBriefing(w);
  await drainJobs(w);
  return fb;
}

async function expectDomainError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

describe("askQuestion", () => {
  it("answers from the published revision with citations bound to that revision", async () => {
    const fb = await indexedBriefing();
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR_QUESTION });
    expect(res.status).toBe("answered");
    expect(res.revisionNumber).toBe(1);
    expect(res.threadId).toBeTruthy();
    expect(res.parts.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations.some((c) => c.kind === "evidence" && c.evidenceId === "ev_cohort_q3")).toBe(true);

    const rev = fb.revisions[0]!;
    const rows = await withSystemContext(w.h.db, (tx) => tx.select().from(answerCitations));
    expect(rows.length).toBe(res.citations.length);
    const evidenceRows = await withSystemContext(w.h.db, (tx) =>
      tx.select({ id: revisionEvidence.id }).from(revisionEvidence).where(eq(revisionEvidence.revisionId, rev.id)),
    );
    const allowed = new Set(evidenceRows.map((r) => r.id));
    for (const r of rows) {
      expect(r.revisionId).toBe(rev.id);
      if (r.evidenceId) expect(allowed.has(r.evidenceId)).toBe(true);
    }
  });

  it("excludes private source chunks and candidate evidence from the reader corpus", async () => {
    const fb = await indexedBriefing();
    const SECRET = "Zanzibar Quokka acquisition codename";
    const src = await addSource(w.h.db, w.ctx("maya"), {
      briefingId: fb.id,
      kind: "text",
      text: `Confidential: the ${SECRET} is planned for next year.`,
      origin: "upload",
    });
    await drainJobs(w);
    const extraction = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
    expect(extraction.status).toBe("succeeded");
    // Candidate evidence in the draft, from the private chunk.
    await createEvidenceFromChunk(w.h.db, w.ctx("maya"), {
      briefingId: fb.id,
      expectedVersion: 1,
      chunkId: extraction.chunks[0]!.id,
      title: "Codename memo",
    });

    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: "What is the Zanzibar Quokka acquisition codename?" });
    expect(res.status).toBe("insufficient");
    expect(res.citations).toEqual([]);
    expect(JSON.stringify(res)).not.toContain("Quokka acquisition codename is");

    const chunks = await withSystemContext(w.h.db, (tx) => tx.select({ text: retrievalChunks.text }).from(retrievalChunks));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes("Zanzibar"))).toBe(false);
  });

  it("rejects a revision from another tenant", async () => {
    const fb = await indexedBriefing();
    await expectDomainError(askQuestion(w.h.db, w.ctx("taylor", "globex"), { briefingId: fb.id, question: NRR_QUESTION }), "not_found");
  });

  it("returns preparing for an unindexed revision and never falls back", async () => {
    const fb = await indexedBriefing();
    await publishRevision(w, fb); // revision 2, not indexed yet
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR_QUESTION });
    expect(res).toMatchObject({ status: "preparing", revisionNumber: 2, threadId: null, citations: [] });
    const threads = await withSystemContext(w.h.db, (tx) => tx.select().from(qaThreads));
    expect(threads).toHaveLength(0);

    // The pinned, indexed revision still answers, as itself.
    const pinned = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, revisionNumber: 1, question: NRR_QUESTION });
    expect(pinned).toMatchObject({ status: "answered", revisionNumber: 1 });
  });

  it("binds a thread to one revision", async () => {
    const fb = await indexedBriefing();
    const first = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR_QUESTION });
    await publishRevision(w, fb);
    await drainJobs(w);
    // Current is now revision 2: continuing the revision-1 thread is refused.
    await expectDomainError(
      askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, threadId: first.threadId!, question: "And enterprise?" }),
      "conflict",
    );
    const cont = await askQuestion(w.h.db, w.ctx("alex"), {
      briefingId: fb.id,
      revisionNumber: 1,
      threadId: first.threadId!,
      question: "What was enterprise net revenue retention?",
    });
    expect(cont.threadId).toBe(first.threadId);
    expect(cont.revisionNumber).toBe(1);
    // Another reader cannot continue it.
    await expectDomainError(
      askQuestion(w.h.db, w.ctx("priya"), { briefingId: fb.id, revisionNumber: 1, threadId: first.threadId!, question: "Hi there" }),
      "not_found",
    );
  });

  it("keeps threads private from the author and other readers", async () => {
    const fb = await indexedBriefing();
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR_QUESTION });
    expect(await getMyThreads(w.h.db, w.ctx("maya"), fb.id)).toEqual([]);
    expect(await getMyThreads(w.h.db, w.ctx("priya"), fb.id)).toEqual([]);
    const mine = await getMyThreads(w.h.db, w.ctx("alex"), fb.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.messages.map((m) => m.role)).toEqual(["reader", "assistant"]);
    expect(mine[0]!.messages[0]!.text).toBe(NRR_QUESTION);
    expect(mine[0]!.messages[1]!.citations.length).toBeGreaterThan(0);
  });

  it("fails honestly when org policy disallows every provider, and reading is unaffected", async () => {
    const fb = await indexedBriefing();
    await withSystemContext(w.h.db, (tx) =>
      tx.update(organizations).set({ settings: { ai: { allowedProviders: ["some-external-vendor"] } } }).where(eq(organizations.id, fb.organizationId)),
    );
    const res = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: NRR_QUESTION });
    expect(res.status).toBe("failed");
    expect(res.parts).toEqual([]);
    expect(res.missing).toMatch(/unavailable/i);

    const c = w.ctx("alex");
    const read = await withAuthContext(w.h.db, c, async (tx) => {
      const ok = await canReadRevision(tx, c, fb.id, fb.revisions[0]!.id);
      const [r] = await tx.select({ doc: briefingRevisions.documentJson }).from(briefingRevisions).where(eq(briefingRevisions.id, fb.revisions[0]!.id));
      return { ok, doc: r?.doc };
    });
    expect(read.ok).toBe(true);
    expect(read.doc).toBeTruthy();
    await expect(
      recordEngagementEvent(w.h.db, c, { briefingId: fb.id, revisionNumber: 1, type: "open", sessionKey: "session-aaaa" }),
    ).resolves.toEqual({ recorded: true });
  });
});

describe("feedback", () => {
  it("get_author_feedback returns submitted items only, never raw questions", async () => {
    const fb = await indexedBriefing();
    const PRIVATE_Q = "Is the mid-market pilot budget already committed privately?";
    const asked = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: PRIVATE_Q });
    const submitted = await submitFeedback(w.h.db, w.ctx("alex"), {
      briefingId: fb.id,
      revisionNumber: 1,
      blockId: "blk_rec_decision",
      type: "question",
      text: "Please state the pilot budget.",
      fromThreadId: asked.threadId!,
    });
    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.feedback.map((f) => f.id)).toEqual([submitted.feedbackId]);
    expect(out.feedback[0]).toMatchObject({ text: "Please state the pilot budget.", revisionNumber: 1, label: "reader_statements" });
    expect(out.feedback[0]!.block?.blockId).toBe("blk_rec_decision");
    expect(JSON.stringify(out)).not.toContain(PRIVATE_Q);
    expect(out.disclosure).toMatch(/private/);

    // Readers without view_engagement cannot see it.
    await expectDomainError(getAuthorFeedback(w.h.db, w.ctx("priya"), { briefingId: fb.id }), "forbidden");

    // Block context survives a later revision.
    const resolved = await resolveFeedback(w.h.db, w.ctx("maya"), { feedbackId: submitted.feedbackId, status: "resolved", resolutionRef: { revisionNumber: 1 } });
    expect(resolved.status).toBe("resolved");
    const list = await listSubmittedFeedback(w.h.db, w.ctx("maya"), fb.id);
    expect(list[0]).toMatchObject({ status: "resolved", resolutionRevisionNumber: 1 });
    expect(list[0]!.block?.sectionTitle).toBe("The recommendation");
  });

  it("suppresses topics below 3 distinct readers and shows them at 3", async () => {
    const fb = await indexedBriefing();
    const qs = {
      alex: "What is the pilot budget?",
      priya: "How large is the pilot budget?",
      jordan: "Who approves the pilot budget?",
    } as const;
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: fb.id, question: qs.alex });
    await askQuestion(w.h.db, w.ctx("priya"), { briefingId: fb.id, question: qs.priya });
    await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id);
    await drainJobs(w);
    let out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.topics).toEqual([]);
    expect(out.suppressedQuestionCount).toBe(2);

    await askQuestion(w.h.db, w.ctx("jordan"), { briefingId: fb.id, question: qs.jordan });
    const req = await requestTopicSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(req.created).toBe(true);
    await drainJobs(w);
    out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: fb.id });
    expect(out.topics.length).toBeGreaterThan(0);
    expect(out.topics[0]).toMatchObject({ readerCount: 3, questionCount: 3, revisionNumber: 1, label: "generated_topic_summary" });
    const text = JSON.stringify(out);
    for (const q of Object.values(qs)) expect(text).not.toContain(q);

    const summary = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(summary.topics.items.length).toBeGreaterThan(0);
    expect(summary.revisions[0]!.measured.questionsAsked).toBe(3);
  });
});

describe("engagement events", () => {
  it("dedupes events and suppresses small distinct-reader counts", async () => {
    const fb = await indexedBriefing();
    const ev = { briefingId: fb.id, revisionNumber: 1, type: "open" as const, sessionKey: "session-1111" };
    expect(await recordEngagementEvent(w.h.db, w.ctx("alex"), ev)).toEqual({ recorded: true });
    expect(await recordEngagementEvent(w.h.db, w.ctx("alex"), ev)).toEqual({ recorded: false });
    expect(await recordEngagementEvent(w.h.db, w.ctx("alex"), { ...ev, sessionKey: "session-2222" })).toEqual({ recorded: true });
    expect(await recordEngagementEvent(w.h.db, w.ctx("priya"), ev)).toEqual({ recorded: true });
    await recordEngagementEvent(w.h.db, w.ctx("alex"), { ...ev, type: "section_view", blockId: "sec_recommendation" });
    await expectDomainError(recordEngagementEvent(w.h.db, w.ctx("alex"), { ...ev, type: "block_view", blockId: "blk_nope" }), "validation");

    let s = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(s.revisions[0]!.measured).toMatchObject({
      opens: null,
      opensSuppressed: true,
      sectionViews: null,
      sectionViewsSuppressed: true,
      distinctReaders: { value: null, suppressed: true },
    });
    expect(s.disclosure).toMatch(/not comprehension/);

    await recordEngagementEvent(w.h.db, w.ctx("jordan"), ev);
    s = await getEngagementSummary(w.h.db, w.ctx("maya"), fb.id);
    expect(s.revisions[0]!.measured.distinctReaders).toEqual({ value: 3, suppressed: false });
    expect(s.revisions[0]!.measured).toMatchObject({ opens: 4, opensSuppressed: false, sectionViews: null, sectionViewsSuppressed: true });

    await expectDomainError(getEngagementSummary(w.h.db, w.ctx("alex"), fb.id), "forbidden");
    await expectDomainError(
      recordEngagementEvent(w.h.db, w.ctx("taylor", "globex"), ev),
      "not_found",
    );
  });
});
