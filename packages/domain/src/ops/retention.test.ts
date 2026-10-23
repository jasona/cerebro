import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerCitations,
  auditEvents,
  briefingDrafts,
  briefingSources,
  engagementEvents,
  engagementInsights,
  feedback,
  jobs,
  qaMessages,
  qaThreads,
  retrievalChunks,
  revisionEvidence,
  sourceChunks,
  sources,
  withSystemContext,
  type Tx,
} from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDraft, updateDraft } from "../briefings/index";
import { askQuestion, recordEngagementEvent, requestTopicSummary, submitFeedback } from "../engagement/index";
import { drainJobs } from "../engagement/test-fixtures";
import { DomainError } from "../errors";
import { runJobsOnce } from "../jobs/runner";
import { createPreview, publishBriefing } from "../publication/index";
import { makeDraft } from "../publication/test-utils";
import { addSource, createEvidenceFromChunk, getSourceExtraction, LocalSourceStore, setSourceStore } from "../sources/index";
import { createTestWorld, type TestWorld } from "../testing";
import {
  applyRetention,
  deleteSource,
  detachSourcesFromDraft,
  enqueueDueRetentionSweeps,
  getRetentionPolicy,
  setRetentionPolicy,
} from "./retention";

let w: TestWorld;
let objects: string;

beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-retention-"));
  setSourceStore(new LocalSourceStore(objects));
});
afterEach(async () => {
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withSystemContext(w.h.db, fn);
const count = async (table: PgTable): Promise<number> =>
  (await sys((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(table)))[0]!.n;

async function objectFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const org of await readdir(objects).catch(() => [] as string[])) {
    for (const f of await readdir(join(objects, org))) out.push(`${org}/${f}`);
  }
  return out;
}

const SOURCE_TEXT = "# Board memo\n\nThe Kestrel programme cut onboarding time by 41 percent across three pilot regions.\n\nSecond paragraph about Kestrel staffing and the hiring plan for next year.";

/**
 * A draft with an uploaded source: one approved evidence item from it
 * (published into a revision) and one candidate referenced from a block.
 */
async function draftWithSource(text = SOURCE_TEXT) {
  const d = await makeDraft(w, { user: "maya" });
  const src = await addSource(w.h.db, d.ctx, {
    briefingId: d.briefingId,
    kind: "markdown",
    bytes: new TextEncoder().encode(text),
    filename: "memo.md",
    origin: "upload",
  });
  await drainJobs(w);
  const ex = await getSourceExtraction(w.h.db, d.ctx, src.sourceId);
  expect(ex.status).toBe("succeeded");
  const a = await createEvidenceFromChunk(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: d.version, chunkId: ex.chunks[0]!.id, title: "Memo A" });
  const b = await createEvidenceFromChunk(w.h.db, d.ctx, {
    briefingId: d.briefingId,
    expectedVersion: a.lockVersion,
    chunkId: ex.chunks[ex.chunks.length - 1]!.id,
    title: "Memo B",
  });
  const draft = await getDraft(w.h.db, d.ctx, d.briefingId);
  const doc = structuredClone(draft.document);
  doc.evidence = doc.evidence.map((e) => (e.id === a.evidenceId ? { ...e, status: "approved" as const } : e));
  doc.sections[0]!.blocks[0]!.evidenceRefs = [...doc.sections[0]!.blocks[0]!.evidenceRefs, { evidenceId: b.evidenceId }];
  const up = await updateDraft(w.h.db, d.ctx, { briefingId: d.briefingId, expectedVersion: draft.lockVersion, document: doc });
  const preview = await createPreview(w.h.db, d.ctx, { briefingId: d.briefingId });
  await publishBriefing(w.h.db, d.ctx, { briefingId: d.briefingId, previewId: preview.previewId });
  await drainJobs(w);
  return { d, sourceId: src.sourceId, approvedId: a.evidenceId, candidateId: b.evidenceId, version: up.draftVersion };
}

async function backdate(table: "sources" | "qa_threads" | "engagement_events", days: number) {
  const col = table === "engagement_events" ? "occurred_at" : table === "qa_threads" ? "updated_at" : "created_at";
  await sys((tx) => tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(col)} = now() - make_interval(days => ${days}::int)`));
}

async function snapshot() {
  return {
    sources: await count(sources),
    chunks: await count(sourceChunks),
    links: await count(briefingSources),
    threads: await count(qaThreads),
    messages: await count(qaMessages),
    citations: await count(answerCitations),
    events: await count(engagementEvents),
    feedback: await count(feedback),
    evidence: await count(revisionEvidence),
    retrieval: await count(retrievalChunks),
    objects: (await objectFiles()).length,
  };
}

describe("retention policy", () => {
  it("defaults every category to keep, and only owners/admins may change it (audited)", async () => {
    const policy = await getRetentionPolicy(w.h.db, w.ctx("riley"));
    expect(policy).toEqual({
      sources: { retainDays: null, updatedAt: null },
      conversations: { retainDays: null, updatedAt: null },
      events: { retainDays: null, updatedAt: null },
    });
    await expect(getRetentionPolicy(w.h.db, w.ctx("maya"))).rejects.toSatisfy((e) => e instanceof DomainError && e.code === "forbidden");
    await expect(setRetentionPolicy(w.h.db, w.ctx("maya"), { category: "events", retainDays: 7 })).rejects.toSatisfy(
      (e) => e instanceof DomainError && e.code === "forbidden",
    );
    const next = await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "events", retainDays: 7 });
    expect(next.events.retainDays).toBe(7);
    const cleared = await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "events", retainDays: null });
    expect(cleared.events.retainDays).toBeNull();
    const audits = await sys((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "retention.policy_changed")));
    expect(audits.map((a) => a.metadata)).toEqual([
      { category: "events", retainDays: 7 },
      { category: "events", retainDays: null },
    ]);
    // Another company cannot see or change Acme's policy.
    const globex = await getRetentionPolicy(w.h.db, w.ctx("taylor", "globex"));
    expect(globex.events.retainDays).toBeNull();
  });

  it("deletes nothing when no policy is set, however old the data is", async () => {
    const s = await draftWithSource();
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: s.d.briefingId, question: "What did Kestrel change?" });
    await recordEngagementEvent(w.h.db, w.ctx("alex"), { briefingId: s.d.briefingId, revisionNumber: 1, type: "open", sessionKey: "session-0001" });
    for (const t of ["sources", "qa_threads", "engagement_events"] as const) await backdate(t, 10_000);
    const before = await snapshot();
    expect(before.objects).toBe(1);
    const res = await applyRetention(w.h.db, w.seed.orgs.acme.id);
    expect(res.categories).toEqual({});
    expect(await snapshot()).toEqual(before);
    // A cleared (null) policy is the same as none.
    await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "sources", retainDays: null });
    expect((await applyRetention(w.h.db, w.seed.orgs.acme.id)).categories).toEqual({});
    expect(await snapshot()).toEqual(before);
  });
});

describe("source retention and hard delete propagate", () => {
  async function expectSourceGone(s: Awaited<ReturnType<typeof draftWithSource>>) {
    expect(await sys((tx) => tx.select().from(sources).where(eq(sources.id, s.sourceId)))).toEqual([]);
    expect(await sys((tx) => tx.select().from(sourceChunks).where(eq(sourceChunks.sourceId, s.sourceId)))).toEqual([]);
    expect(await sys((tx) => tx.select().from(briefingSources).where(eq(briefingSources.sourceId, s.sourceId)))).toEqual([]);
    // No orphaned chunk or embedding anywhere.
    const orphans = await sys((tx) =>
      tx.execute(sql`select 1 from source_chunks c where not exists (select 1 from sources s where s.organization_id = c.organization_id and s.id = c.source_id)`),
    );
    expect(orphans.rows).toEqual([]);
    expect(await objectFiles()).toEqual([]);

    // Draft: candidate from the source and its block reference removed; approved kept without provenance.
    const draft = await getDraft(w.h.db, w.ctx("maya"), s.d.briefingId);
    expect(draft.document.evidence.find((e) => e.id === s.candidateId)).toBeUndefined();
    expect(JSON.stringify(draft.document.sections)).not.toContain(s.candidateId);
    const approved = draft.document.evidence.find((e) => e.id === s.approvedId)!;
    expect(approved.status).toBe("approved");
    expect(approved.sourceRef).toBeUndefined();
    expect(JSON.stringify(draft.document)).not.toContain(s.sourceId);
    expect(draft.lockVersion).toBe(s.version + 1);

    // Published evidence keeps its approved excerpt; only the provenance link is cleared.
    const ev = await sys((tx) => tx.select().from(revisionEvidence).where(eq(revisionEvidence.evidenceKey, s.approvedId)));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.sourceId).toBeNull();
    expect(ev[0]!.excerpt).toContain("Kestrel");

    // The author can keep editing and publishing.
    const up = await updateDraft(w.h.db, w.ctx("maya"), {
      briefingId: s.d.briefingId,
      expectedVersion: draft.lockVersion,
      document: { ...draft.document, title: "Kestrel review, revised" },
    });
    const preview = await createPreview(w.h.db, w.ctx("maya"), { briefingId: s.d.briefingId });
    const pub = await publishBriefing(w.h.db, w.ctx("maya"), { briefingId: s.d.briefingId, previewId: preview.previewId });
    expect(pub.revisionNumber).toBe(2);
    expect(up.draftVersion).toBe(draft.lockVersion + 1);
  }

  it("retention deletes expired sources with everything derived from them, and keeps the rest", async () => {
    const s = await draftWithSource();
    await backdate("sources", 40);
    // A fresh source (shares no object) must survive.
    const fresh = await addSource(w.h.db, w.ctx("maya"), {
      briefingId: s.d.briefingId,
      kind: "markdown",
      bytes: new TextEncoder().encode("# Fresh\n\nA recent note about Osprey."),
      origin: "upload",
    });
    await drainJobs(w);
    const retrievalBefore = await count(retrievalChunks);

    await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "sources", retainDays: 30 });
    const res = await applyRetention(w.h.db, w.seed.orgs.acme.id);
    expect(res.categories.sources).toMatchObject({ retainDays: 30, deleted: 1, deletedObjects: 1, updatedDrafts: 1 });
    expect(res.categories.sources!.deletedChunks).toBeGreaterThan(0);

    const remaining = await sys((tx) => tx.select({ id: sources.id }).from(sources));
    expect(remaining.map((r) => r.id)).toEqual([fresh.sourceId]);
    expect(await sys((tx) => tx.select().from(sourceChunks).where(eq(sourceChunks.sourceId, fresh.sourceId)))).not.toEqual([]);
    expect(await objectFiles()).toHaveLength(1);
    expect(await count(retrievalChunks)).toBe(retrievalBefore);

    const [audit] = await sys((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "retention.applied")));
    expect(audit!.metadata).toMatchObject({ category: "sources", retainDays: 30, deleted: 1 });
    expect(JSON.stringify(audit!.metadata)).not.toContain("Kestrel");

    // Remove the fresh one too, then check full propagation for the expired source.
    await deleteSource(w.h.db, w.ctx("maya"), { sourceId: fresh.sourceId });
    await expectSourceGone(s);
  });

  it("keeps a shared content-addressed object while another source still uses it", async () => {
    const s = await draftWithSource();
    const twin = await addSource(w.h.db, w.ctx("maya"), {
      kind: "markdown",
      bytes: new TextEncoder().encode(SOURCE_TEXT),
      origin: "upload",
    });
    expect(await objectFiles()).toHaveLength(1);
    const res = await deleteSource(w.h.db, w.ctx("maya"), { sourceId: s.sourceId });
    expect(res.deletedObjects).toBe(0);
    expect(await objectFiles()).toHaveLength(1);
    await deleteSource(w.h.db, w.ctx("maya"), { sourceId: twin.sourceId });
    expect(await objectFiles()).toEqual([]);
  });

  it("an author hard-deletes their source; others cannot; an admin can as the privileged path", async () => {
    const s = await draftWithSource();
    for (const who of ["alex", "priya"] as const) {
      await expect(deleteSource(w.h.db, w.ctx(who), { sourceId: s.sourceId })).rejects.toSatisfy(
        (e) => e instanceof DomainError && e.code === "not_found",
      );
    }
    await expect(deleteSource(w.h.db, w.ctx("taylor", "globex"), { sourceId: s.sourceId })).rejects.toSatisfy(
      (e) => e instanceof DomainError && e.code === "not_found",
    );
    const res = await deleteSource(w.h.db, w.ctx("maya"), { sourceId: s.sourceId });
    expect(res).toMatchObject({ sourceId: s.sourceId, updatedDrafts: 1, deletedObjects: 1 });
    await expectSourceGone(s);
    const [audit] = await sys((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "source.deleted")));
    expect(audit!.metadata).toMatchObject({ privileged: false, updatedDrafts: 1, objects: 1 });

    const other = await addSource(w.h.db, w.ctx("maya"), { kind: "text", text: "Private planning note.", origin: "manual" });
    const byAdmin = await deleteSource(w.h.db, w.ctx("riley"), { sourceId: other.sourceId });
    expect(byAdmin.sourceId).toBe(other.sourceId);
    const audits = await sys((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "source.deleted")));
    expect(audits.find((a) => a.targetId === other.sourceId)!.metadata).toMatchObject({ privileged: true });
  });

  it("detachSourcesFromDraft leaves unrelated documents untouched", () => {
    expect(detachSourcesFromDraft({ evidence: [{ id: "ev_a", sourceRef: { sourceId: "x" } }], sections: [] }, new Set(["y"]))).toBeNull();
    expect(detachSourcesFromDraft(null, new Set(["y"]))).toBeNull();
  });
});

describe("conversation and event retention", () => {
  it("deletes expired private threads with messages and citations, keeping submitted feedback", async () => {
    const s = await draftWithSource();
    const id = s.d.briefingId;
    const old = await askQuestion(w.h.db, w.ctx("alex"), { briefingId: id, question: "How much did Kestrel cut onboarding time?" });
    for (const u of ["priya", "jordan"] as const) await askQuestion(w.h.db, w.ctx(u), { briefingId: id, question: "How much did Kestrel cut onboarding?" });
    await submitFeedback(w.h.db, w.ctx("alex"), { briefingId: id, revisionNumber: 1, type: "question", text: "Please add regions.", fromThreadId: old.threadId! });
    await requestTopicSummary(w.h.db, w.ctx("maya"), id);
    await drainJobs(w);
    await backdate("qa_threads", 100);
    const recent = await askQuestion(w.h.db, w.ctx("sam"), { briefingId: id, question: "Who staffs Kestrel?" });
    expect(await count(answerCitations)).toBeGreaterThan(0);

    await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "conversations", retainDays: 90 });
    const res = await applyRetention(w.h.db, w.seed.orgs.acme.id);
    expect(res.categories.conversations).toMatchObject({ retainDays: 90, deleted: 3, deletedMessages: 6 });

    const threads = await sys((tx) => tx.select({ id: qaThreads.id }).from(qaThreads));
    expect(threads.map((t) => t.id)).toEqual([recent.threadId]);
    const orphanMsgs = await sys((tx) =>
      tx.execute(sql`select 1 from qa_messages m where not exists (select 1 from qa_threads t where t.id = m.thread_id)`),
    );
    expect(orphanMsgs.rows).toEqual([]);
    const orphanCites = await sys((tx) =>
      tx.execute(sql`select 1 from answer_citations c where not exists (select 1 from qa_messages m where m.id = c.message_id)`),
    );
    expect(orphanCites.rows).toEqual([]);
    const [fb] = await sys((tx) => tx.select().from(feedback));
    expect(fb).toMatchObject({ text: "Please add regions.", qaThreadId: null });
    const remainingMsgIds = new Set((await sys((tx) => tx.select({ id: qaMessages.id }).from(qaMessages))).map((m) => m.id));
    for (const ins of await sys((tx) => tx.select().from(engagementInsights))) {
      for (const ref of ins.supportingRefs as { id: string }[]) expect(remainingMsgIds.has(ref.id)).toBe(true);
    }
  });

  it("deletes expired measured events only", async () => {
    const s = await draftWithSource();
    const ev = { briefingId: s.d.briefingId, revisionNumber: 1, type: "open" as const };
    await recordEngagementEvent(w.h.db, w.ctx("alex"), { ...ev, sessionKey: "session-old-1" });
    await recordEngagementEvent(w.h.db, w.ctx("priya"), { ...ev, sessionKey: "session-old-2" });
    await backdate("engagement_events", 30);
    await recordEngagementEvent(w.h.db, w.ctx("jordan"), { ...ev, sessionKey: "session-new-1" });
    await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "events", retainDays: 7 });
    const res = await applyRetention(w.h.db, w.seed.orgs.acme.id);
    expect(res.categories.events).toEqual({ retainDays: 7, deleted: 2 });
    expect(await count(engagementEvents)).toBe(1);
    // Globex data is never touched by Acme's policy.
    expect((await applyRetention(w.h.db, w.seed.orgs.globex.id)).categories).toEqual({});
  });
});

describe("scheduled sweeps", () => {
  it("are off by default, and enqueue one job per organization with a policy per interval when enabled", async () => {
    await setRetentionPolicy(w.h.db, w.ctx("riley"), { category: "events", retainDays: 7 });
    expect(await enqueueDueRetentionSweeps(w.h.db, {})).toBe(0);
    const env = { RETENTION_SWEEP_INTERVAL_SECONDS: "3600" };
    const now = new Date();
    expect(await enqueueDueRetentionSweeps(w.h.db, env, now)).toBe(1);
    expect(await enqueueDueRetentionSweeps(w.h.db, env, now)).toBe(0);
    const res = await runJobsOnce(w.h.db, { workerId: "t", limit: 10, kinds: ["apply_retention"] });
    expect(res.outcomes).toEqual([expect.objectContaining({ kind: "apply_retention", result: "succeeded" })]);
    const [job] = await sys((tx) => tx.select().from(jobs).where(eq(jobs.kind, "apply_retention")));
    expect(job!.organizationId).toBe(w.seed.orgs.acme.id);
    expect(existsSync(objects)).toBe(true);
  });
});
