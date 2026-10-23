import { createHash } from "node:crypto";
import { runTask, SummarizeTopicsTask } from "@cerebro/ai";
import { engagementInsights, withAuthContext, type Database, type Job } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getBriefingCapabilities } from "../access/index";
import { recordAudit } from "../audit";
import { getAiRegistry, resolveOrgAiPolicy } from "../engagement/ai-runtime";
import { ENGAGEMENT_SETTINGS, SUPPRESSED_TOPIC } from "../engagement/settings";
import { checkAiUsage, recordAiRun } from "../ops/ai-usage";
import { JobError, permanent, requireJobOrg, workerContext } from "./errors";

const Payload = z.object({
  briefingId: z.string().uuid(),
  revisionId: z.string().uuid(),
  requestedBy: z.string().uuid(),
});


/**
 * Aggregate a revision's private reader questions into topic insights.
 *
 * This is the privileged analysis path D07 allows: it reads question text
 * (never answers) for clustering, runs as the requesting user after
 * rechecking `view_engagement`, and stores only topic labels, counts and
 * question ids. Topics drawing on fewer than ENGAGEMENT_SETTINGS.minCohort
 * distinct readers are dropped and counted in a reserved `__suppressed__` row.
 * Each run inserts a new batch under one watermark (the runtime role cannot
 * delete insights); readers of insights use the latest watermark only.
 */
export async function handleSummarizeTopics(db: Database, job: Job): Promise<void> {
  const organizationId = requireJobOrg(job);
  const parsed = Payload.safeParse(job.payload);
  if (!parsed.success) throw permanent("invalid_payload");
  const { briefingId, revisionId, requestedBy } = parsed.data;
  const ctx = workerContext(job, requestedBy);
  const auth = { userId: ctx.userId, organizationId };

  const prepared = await withAuthContext(db, auth, async (tx) => {
    const caps = await getBriefingCapabilities(tx, ctx, briefingId);
    if (!caps.has("view_engagement")) throw permanent("forbidden");
    const res = await tx.execute<{ id: string; content: string; reader_id: string }>(sql`
      select m.id, m.content, t.reader_id
      from qa_messages m
      join qa_threads t on t.organization_id = m.organization_id and t.id = m.thread_id
      where m.organization_id = ${organizationId}::uuid
        and t.briefing_id = ${briefingId}::uuid
        and t.revision_id = ${revisionId}::uuid
        and m.role = 'reader'
      order by m.created_at, m.id
      limit 5000`);
    const policy = await resolveOrgAiPolicy(tx, organizationId);
    const usage = await checkAiUsage(tx, organizationId);
    return { rows: res.rows, policy, usage };
  });
  // Over the organization's AI usage limit: retry later, like an outage.
  if (!prepared.usage.allowed) throw new JobError("ai_usage_limited", true);

  const questions = prepared.rows
    .filter((r) => r.content.trim().length > 0)
    .map((r) => ({
      id: r.id,
      text: r.content.slice(0, 2000),
      readerHash: createHash("sha256").update(`${organizationId}:${r.reader_id}`).digest("hex"),
    }));

  const readerHashById = new Map(questions.map((q) => [q.id, q.readerHash]));

  let provider;
  try {
    provider = getAiRegistry().resolve("summarize_topics", prepared.policy);
  } catch {
    throw new JobError("ai_unavailable", true);
  }
  const res = await runTask(
    provider,
    SummarizeTopicsTask,
    { questions, maxTopics: ENGAGEMENT_SETTINGS.maxTopics, minDistinctReaders: ENGAGEMENT_SETTINGS.minCohort },
    { timeoutMs: ENGAGEMENT_SETTINGS.topicsTimeoutMs },
  );

  await withAuthContext(db, auth, async (tx) => {
    await recordAiRun(tx, organizationId, requestedBy, res.record);
    if (!res.ok) return;
    // Recheck before writing: access may have changed during the AI run.
    if (!(await getBriefingCapabilities(tx, ctx, briefingId)).has("view_engagement")) throw permanent("forbidden");

    const watermark = new Date();
    const rows: (typeof engagementInsights.$inferInsert)[] = [];
    // Never trust the provider's counts: distinct readers and question counts
    // are recomputed from the stored reader hashes of the question ids it
    // assigned, and the cohort rule is applied to the computed value.
    const assigned = new Set<string>();
    for (const t of res.output.topics) {
      const ids = [...new Set([...(t.questionIds ?? []), ...t.exampleQuestionIds])].filter(
        (id) => readerHashById.has(id) && !assigned.has(id),
      );
      const distinctReaders = new Set(ids.map((id) => readerHashById.get(id)!)).size;
      if (distinctReaders < ENGAGEMENT_SETTINGS.minCohort) continue;
      for (const id of ids) assigned.add(id);
      const examples = t.exampleQuestionIds.filter((id) => readerHashById.has(id));
      rows.push({
        organizationId,
        briefingId,
        revisionId,
        topic: t.label,
        summary: null,
        readerCount: distinctReaders,
        questionCount: ids.length,
        supportingRefs: examples.map((id) => ({ type: "question", id })),
        watermark,
      });
    }
    // Every question not counted in a published topic is withheld. The row
    // records how many distinct readers asked them, so that the withheld
    // count can itself be cohort-suppressed when shown (D07, W3.6).
    const withheld = questions.filter((q) => !assigned.has(q.id));
    const suppressed = withheld.length;
    rows.push({
      organizationId,
      briefingId,
      revisionId,
      topic: SUPPRESSED_TOPIC,
      summary: null,
      readerCount: new Set(withheld.map((q) => q.readerHash)).size,
      questionCount: suppressed,
      supportingRefs: [],
      watermark,
    });
    await tx.insert(engagementInsights).values(rows);
    await recordAudit(tx, ctx, {
      action: "engagement.topics_summarized",
      targetType: "briefing",
      targetId: briefingId,
      revisionId,
      metadata: { topics: rows.length - 1, suppressedQuestions: suppressed },
    });
  });
  if (!res.ok) throw new JobError(`ai_${res.error.category}`, res.error.category === "unavailable" || res.error.category === "timeout");
}
