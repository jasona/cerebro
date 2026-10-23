/**
 * Retention and deletion (W4). P11 (the retention policy) is not set, so by
 * default nothing is ever deleted:
 *
 * - `retention_policies` holds, per organization and category, how many days
 *   to keep. No row, or a null value, keeps the category indefinitely.
 * - `applyRetention` deletes data older than the policy for each category
 *   that has one, propagating to everything derived from it. It runs as the
 *   `apply_retention` job; sweeps are scheduled only when
 *   `RETENTION_SWEEP_INTERVAL_SECONDS` is set (off by default), or run once
 *   with `npm run retention:sweep`.
 * - `deleteSource` is the author/admin hard delete of one private source,
 *   with the same propagation.
 *
 * Propagation for a deleted source: the stored original (SourceStore object,
 * when no other source in the organization shares its content-addressed
 * key), extracted chunks and their embeddings, briefing links, and the
 * draft-side copies: candidate/excluded evidence items taken from the source
 * are removed from drafts (with the block references to them), and approved
 * draft evidence keeps its excerpt but loses its `sourceRef`. Published
 * revision evidence keeps its approved excerpt (it belongs to the immutable
 * revision) and only its provenance link is cleared (migration 0009).
 * Reader retrieval projections are built only from published blocks and
 * approved evidence, never from source chunks, so they are unaffected.
 *
 * Audit events are append-only and are not deleted here; every deletion is
 * itself audited with counts only.
 */
import {
  auditEvents,
  briefingDrafts,
  enqueueJob,
  getDatabase,
  organizations,
  RETENTION_CATEGORIES,
  retentionPolicies,
  withAuthContext,
  withSystemContext,
  type Database,
  type Job,
  type RetentionCategory,
  type Tx,
} from "@cerebro/database";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getMembership } from "../access/index";
import { recordAudit } from "../audit";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { JobError, permanent } from "../jobs/errors";
import { canAccessSource, lockSourceObject } from "../sources/sources";
import { getSourceStore } from "../sources/store";
import { createLogger } from "./log";

export { RETENTION_CATEGORIES, type RetentionCategory };

const logger = createLogger({ component: "retention" });
const parseCtx = (ctx: RequestContext) => RequestContext.parse(ctx);
const authOf = (c: RequestContext) => ({ userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId });

/** Rows deleted per statement, so a large backlog does not hold one huge transaction. */
const BATCH = 500;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type RetentionPolicyDto = Record<RetentionCategory, { retainDays: number | null; updatedAt: string | null }>;

async function assertAdmin(tx: Tx, c: RequestContext): Promise<void> {
  const m = await getMembership(tx, c);
  if (!m || (m.role !== "owner" && m.role !== "admin")) {
    throw new DomainError("forbidden", "Only company owners and admins can manage retention.");
  }
}

async function loadPolicy(tx: Tx, organizationId: string): Promise<RetentionPolicyDto> {
  const rows = await tx
    .select({ category: retentionPolicies.category, retainDays: retentionPolicies.retainDays, updatedAt: retentionPolicies.updatedAt })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.organizationId, organizationId));
  const out = Object.fromEntries(RETENTION_CATEGORIES.map((k) => [k, { retainDays: null, updatedAt: null }])) as RetentionPolicyDto;
  for (const r of rows) {
    if ((RETENTION_CATEGORIES as readonly string[]).includes(r.category)) {
      out[r.category as RetentionCategory] = { retainDays: r.retainDays, updatedAt: r.updatedAt.toISOString() };
    }
  }
  return out;
}

/** The organization's retention policy. Every category defaults to keep (null). Owners and admins. */
export async function getRetentionPolicy(db: Database, ctx: RequestContext): Promise<RetentionPolicyDto> {
  const c = parseCtx(ctx);
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertAdmin(tx, c);
    return loadPolicy(tx, c.organizationId);
  });
}

export const SetRetentionPolicyInput = z.object({
  category: z.enum(RETENTION_CATEGORIES),
  /** Days to keep; null keeps indefinitely. */
  retainDays: z.number().int().min(1).max(36_500).nullable(),
});
export type SetRetentionPolicyInput = z.input<typeof SetRetentionPolicyInput>;

/** Set (or clear, with null) one category's retention period. Owners and admins; audited. */
export async function setRetentionPolicy(db: Database, ctx: RequestContext, raw: SetRetentionPolicyInput): Promise<RetentionPolicyDto> {
  const c = parseCtx(ctx);
  const parsed = SetRetentionPolicyInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid retention policy.", { issues: parsed.error.issues.map((i) => i.message) });
  const input = parsed.data;
  return withAuthContext(db, authOf(c), async (tx) => {
    await assertAdmin(tx, c);
    await tx
      .insert(retentionPolicies)
      .values({ organizationId: c.organizationId, category: input.category, retainDays: input.retainDays, updatedBy: c.userId })
      .onConflictDoUpdate({
        target: [retentionPolicies.organizationId, retentionPolicies.category],
        set: { retainDays: input.retainDays, updatedBy: c.userId, updatedAt: sql`now()` },
      });
    await recordAudit(tx, c, {
      action: "retention.policy_changed",
      targetType: "organization",
      targetId: c.organizationId,
      metadata: { category: input.category, retainDays: input.retainDays },
    });
    return loadPolicy(tx, c.organizationId);
  });
}

// ---------------------------------------------------------------------------
// Source purge (shared by deleteSource and retention)
// ---------------------------------------------------------------------------

interface PurgeResult {
  deletedSources: number;
  deletedChunks: number;
  updatedDrafts: number;
  /** Object keys no longer referenced by any source; delete after commit. */
  orphanedKeys: string[];
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Remove a set of sources from a stored draft document (raw JSON): drop
 * non-approved evidence taken from them and the block references to it, and
 * strip `sourceRef` from approved evidence. Returns null when unchanged.
 */
export function detachSourcesFromDraft(doc: unknown, sourceIds: ReadonlySet<string>): unknown | null {
  if (!isObject(doc) || !Array.isArray(doc.evidence)) return null;
  let changed = false;
  const removed = new Set<string>();
  const evidence: unknown[] = [];
  for (const item of doc.evidence) {
    const ref = isObject(item) && isObject(item.sourceRef) ? item.sourceRef : null;
    if (!ref || typeof ref.sourceId !== "string" || !sourceIds.has(ref.sourceId)) {
      evidence.push(item);
      continue;
    }
    changed = true;
    const it = item as JsonObject;
    if (it.status === "approved") {
      const { sourceRef: _drop, ...rest } = it;
      evidence.push(rest);
    } else if (typeof it.id === "string") {
      removed.add(it.id);
    }
  }
  if (!changed) return null;
  const sections = Array.isArray(doc.sections)
    ? doc.sections.map((s) =>
        isObject(s) && Array.isArray(s.blocks)
          ? {
              ...s,
              blocks: s.blocks.map((b) =>
                isObject(b) && Array.isArray(b.evidenceRefs)
                  ? { ...b, evidenceRefs: b.evidenceRefs.filter((r) => !(isObject(r) && typeof r.evidenceId === "string" && removed.has(r.evidenceId))) }
                  : b,
              ),
            }
          : s,
      )
    : doc.sections;
  return { ...doc, evidence, sections };
}

/**
 * Delete sources and everything derived from them inside `tx` (runtime role
 * for deleteSource, owner for retention). Object deletion happens after
 * commit, using `orphanedKeys`.
 */
async function purgeSources(tx: Tx, organizationId: string, sourceIds: string[]): Promise<PurgeResult> {
  if (!sourceIds.length) return { deletedSources: 0, deletedChunks: 0, updatedDrafts: 0, orphanedKeys: [] };
  const ids = sql`array[${sql.join(
    sourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  const keys = (
    await tx.execute<{ object_key: string }>(sql`
      select distinct object_key from sources
      where organization_id = ${organizationId}::uuid and id = any(${ids}) and object_key is not null`)
  ).rows.map((r) => r.object_key);

  // Draft-side copies (see module comment). Bumping lock_version makes open
  // editors and outstanding previews stale, as for any other draft change.
  const drafts = await tx.execute<{ id: string; document_json: unknown }>(sql`
    select id, document_json from briefing_drafts
    where organization_id = ${organizationId}::uuid
      and exists (
        select 1 from jsonb_array_elements(coalesce(document_json->'evidence', '[]'::jsonb)) e
        where e->'sourceRef'->>'sourceId' = any(${ids}::text[]))
    for update`);
  const idSet = new Set(sourceIds);
  let updatedDrafts = 0;
  for (const d of drafts.rows) {
    const next = detachSourcesFromDraft(d.document_json, idSet);
    if (!next) continue;
    await tx
      .update(briefingDrafts)
      .set({ documentJson: next, lockVersion: sql`${briefingDrafts.lockVersion} + 1`, updatedAt: sql`now()` })
      .where(and(eq(briefingDrafts.organizationId, organizationId), eq(briefingDrafts.id, d.id)));
    updatedDrafts++;
  }

  const chunks = await tx.execute<{ id: string }>(sql`
    delete from source_chunks where organization_id = ${organizationId}::uuid and source_id = any(${ids}) returning id`);
  await tx.execute(sql`delete from briefing_sources where organization_id = ${organizationId}::uuid and source_id = any(${ids})`);
  // revision_evidence.source_id is cleared by the foreign key (on delete set null).
  const deleted = await tx.execute<{ id: string }>(sql`
    delete from sources where organization_id = ${organizationId}::uuid and id = any(${ids}) returning id`);

  let orphanedKeys: string[] = [];
  if (keys.length) {
    const keyArr = sql`array[${sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `,
    )}]::text[]`;
    const still = new Set(
      (
        await tx.execute<{ object_key: string }>(sql`
          select distinct object_key from sources where organization_id = ${organizationId}::uuid and object_key = any(${keyArr})`)
      ).rows.map((r) => r.object_key),
    );
    orphanedKeys = keys.filter((k) => !still.has(k));
  }
  return { deletedSources: deleted.rows.length, deletedChunks: chunks.rows.length, updatedDrafts, orphanedKeys };
}

/**
 * Delete stored objects after the database change committed. Each key is
 * deleted under the object lock that addSource also takes, and only if no
 * source references it at that moment: a source with the same bytes may have
 * been added since the purge checked. Failures are logged (keys are not content).
 */
async function deleteObjects(db: Database, organizationId: string, keys: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      // System context: a narrow existence check on object_key in this organization, for any user or none (retention).
      const removed = await withSystemContext(db, async (tx) => {
        await lockSourceObject(tx, key);
        const ref = await tx.execute(sql`
          select 1 from sources where organization_id = ${organizationId}::uuid and object_key = ${key} limit 1`);
        if (ref.rows.length) return false;
        await getSourceStore().delete(organizationId, key);
        return true;
      });
      if (removed) deleted++;
    } catch (err) {
      failed++;
      logger.error("retention.object_delete_failed", { organizationId, errorName: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { deleted, failed };
}

// ---------------------------------------------------------------------------
// deleteSource
// ---------------------------------------------------------------------------

export interface DeleteSourceResult {
  sourceId: string;
  deletedChunks: number;
  updatedDrafts: number;
  deletedObjects: number;
}

/**
 * Permanently delete a private source and everything derived from it.
 *
 * Allowed for anyone who may work with the source (its creator while an
 * active member, or an editor of a linked briefing), and for company owners
 * and admins as the privileged erasure path. Admins delete without seeing
 * the source's content (D09). Everyone else gets `not_found`. Audited with
 * counts only.
 */
export async function deleteSource(db: Database, ctx: RequestContext, raw: { sourceId: string }): Promise<DeleteSourceResult> {
  const c = parseCtx(ctx);
  const parsed = z.object({ sourceId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) throw new DomainError("not_found", "Source not found.");
  const { sourceId } = parsed.data;
  const res = await withAuthContext(db, authOf(c), async (tx) => {
    const m = await getMembership(tx, c);
    const privileged = !!m && (m.role === "owner" || m.role === "admin");
    const exists = await tx.execute<{ id: string }>(sql`
      select id from sources where organization_id = ${c.organizationId}::uuid and id = ${sourceId}::uuid`);
    if (!exists.rows.length) throw new DomainError("not_found", "Source not found.");
    const ownAccess = await canAccessSource(tx, c, sourceId);
    if (!ownAccess && !privileged) throw new DomainError("not_found", "Source not found.");
    const purge = await purgeSources(tx, c.organizationId, [sourceId]);
    await recordAudit(tx, c, {
      action: "source.deleted",
      targetType: "source",
      targetId: sourceId,
      metadata: {
        privileged: !ownAccess,
        deletedChunks: purge.deletedChunks,
        updatedDrafts: purge.updatedDrafts,
        objects: purge.orphanedKeys.length,
      },
    });
    return purge;
  });
  const objects = await deleteObjects(db, c.organizationId, res.orphanedKeys);
  logger.info("source.deleted", {
    organizationId: c.organizationId,
    userId: c.userId,
    deletedChunks: res.deletedChunks,
    updatedDrafts: res.updatedDrafts,
    deletedObjects: objects.deleted,
  });
  return { sourceId, deletedChunks: res.deletedChunks, updatedDrafts: res.updatedDrafts, deletedObjects: objects.deleted };
}

// ---------------------------------------------------------------------------
// applyRetention
// ---------------------------------------------------------------------------

export interface RetentionRunResult {
  organizationId: string;
  categories: Partial<
    Record<
      RetentionCategory,
      { retainDays: number; deleted: number; deletedChunks?: number; deletedObjects?: number; updatedDrafts?: number; deletedMessages?: number }
    >
  >;
}

async function auditRetention(tx: Tx, organizationId: string, category: RetentionCategory, metadata: Record<string, unknown>): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId,
    actorId: null,
    connectionId: null,
    action: "retention.applied",
    targetType: "organization",
    targetId: organizationId,
    revisionId: null,
    metadata: { category, ...metadata },
  });
}

/**
 * Apply an organization's retention policy once. Categories without a period
 * are untouched. Runs under the system context: retention is a privileged
 * operation of the organization's policy, not of any user, and must reach
 * private rows (other readers' Q&A) that no user context may see.
 */
export async function applyRetention(db: Database, organizationId: string): Promise<RetentionRunResult> {
  if (!z.string().uuid().safeParse(organizationId).success) throw new DomainError("validation", "Invalid organization.");
  const result: RetentionRunResult = { organizationId, categories: {} };
  const policy = await withSystemContext(db, (tx) => loadPolicy(tx, organizationId));

  // Sources (and derived data).
  const sourceDays = policy.sources.retainDays;
  if (sourceDays) {
    let deleted = 0;
    let deletedChunks = 0;
    let updatedDrafts = 0;
    let deletedObjects = 0;
    for (;;) {
      const batch = await withSystemContext(db, async (tx) => {
        const ids = (
          await tx.execute<{ id: string }>(sql`
            select id from sources
            where organization_id = ${organizationId}::uuid
              and created_at < now() - make_interval(days => ${sourceDays}::int)
            order by created_at limit ${BATCH}`)
        ).rows.map((r) => r.id);
        return { ids, purge: await purgeSources(tx, organizationId, ids) };
      });
      if (!batch.ids.length) break;
      const objects = await deleteObjects(db, organizationId, batch.purge.orphanedKeys);
      deleted += batch.purge.deletedSources;
      deletedChunks += batch.purge.deletedChunks;
      updatedDrafts += batch.purge.updatedDrafts;
      deletedObjects += objects.deleted;
      if (batch.ids.length < BATCH) break;
    }
    await withSystemContext(db, (tx) =>
      auditRetention(tx, organizationId, "sources", { retainDays: sourceDays, deleted, deletedChunks, updatedDrafts, deletedObjects }),
    );
    result.categories.sources = { retainDays: sourceDays, deleted, deletedChunks, updatedDrafts, deletedObjects };
  }

  // Conversations: whole threads whose last activity is older than the period.
  const convDays = policy.conversations.retainDays;
  if (convDays) {
    let deleted = 0;
    let deletedMessages = 0;
    for (;;) {
      const n = await withSystemContext(db, async (tx) => {
        const threads = (
          await tx.execute<{ id: string }>(sql`
            select id from qa_threads
            where organization_id = ${organizationId}::uuid
              and updated_at < now() - make_interval(days => ${convDays}::int)
            order by updated_at limit ${BATCH}`)
        ).rows.map((r) => r.id);
        if (!threads.length) return { threads: 0, messages: 0 };
        const tIds = sql`array[${sql.join(
          threads.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`;
        const msgIds = (
          await tx.execute<{ id: string }>(sql`
            select id from qa_messages where organization_id = ${organizationId}::uuid and thread_id = any(${tIds})`)
        ).rows.map((r) => r.id);
        if (msgIds.length) {
          const mIds = sql`array[${sql.join(
            msgIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`;
          await tx.execute(sql`delete from answer_citations where organization_id = ${organizationId}::uuid and message_id = any(${mIds})`);
          // Topic insights keep their counts and generated labels; drop references to deleted questions.
          await tx.execute(sql`
            update engagement_insights set supporting_refs = coalesce((
                select jsonb_agg(r) from jsonb_array_elements(supporting_refs) r
                where not (r->>'id' = any(${mIds}::text[]))), '[]'::jsonb),
              updated_at = now()
            where organization_id = ${organizationId}::uuid
              and exists (select 1 from jsonb_array_elements(supporting_refs) r where r->>'id' = any(${mIds}::text[]))`);
          await tx.execute(sql`delete from qa_messages where organization_id = ${organizationId}::uuid and id = any(${mIds})`);
        }
        // Submitted feedback is the reader's explicit statement and is kept; only its link to the private thread goes.
        await tx.execute(sql`
          update feedback set qa_thread_id = null, updated_at = now()
          where organization_id = ${organizationId}::uuid and qa_thread_id = any(${tIds})`);
        await tx.execute(sql`delete from qa_threads where organization_id = ${organizationId}::uuid and id = any(${tIds})`);
        return { threads: threads.length, messages: msgIds.length };
      });
      deleted += n.threads;
      deletedMessages += n.messages;
      if (n.threads < BATCH) break;
    }
    await withSystemContext(db, (tx) => auditRetention(tx, organizationId, "conversations", { retainDays: convDays, deleted, deletedMessages }));
    result.categories.conversations = { retainDays: convDays, deleted, deletedMessages };
  }

  // Measured engagement events.
  const eventDays = policy.events.retainDays;
  if (eventDays) {
    let deleted = 0;
    for (;;) {
      const n = await withSystemContext(db, async (tx) => {
        const res = await tx.execute<{ id: string }>(sql`
          delete from engagement_events where id in (
            select id from engagement_events
            where organization_id = ${organizationId}::uuid
              and occurred_at < now() - make_interval(days => ${eventDays}::int)
            limit ${BATCH * 10})
          returning id`);
        return res.rows.length;
      });
      deleted += n;
      if (n < BATCH * 10) break;
    }
    await withSystemContext(db, (tx) => auditRetention(tx, organizationId, "events", { retainDays: eventDays, deleted }));
    result.categories.events = { retainDays: eventDays, deleted };
  }

  for (const [category, r] of Object.entries(result.categories)) {
    logger.info("retention.applied", { organizationId, category, retainDays: r.retainDays, deleted: r.deleted });
  }
  return result;
}

/** Organizations with at least one category that has a retention period. */
export async function organizationsWithRetention(db: Database): Promise<string[]> {
  // System context: a cross-organization scheduling query over policy rows only.
  return withSystemContext(db, async (tx) => {
    const rows = await tx
      .selectDistinct({ organizationId: retentionPolicies.organizationId })
      .from(retentionPolicies)
      .innerJoin(organizations, eq(organizations.id, retentionPolicies.organizationId))
      .where(isNotNull(retentionPolicies.retainDays));
    return rows.map((r) => r.organizationId);
  });
}

/**
 * Sweep interval from `RETENTION_SWEEP_INTERVAL_SECONDS`, or null when off
 * (the default: no sweep is scheduled until an operator enables it).
 */
export function retentionSweepIntervalSeconds(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.RETENTION_SWEEP_INTERVAL_SECONDS?.trim();
  if (!raw || raw === "off" || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * Enqueue one `apply_retention` job per organization with a policy, at most
 * once per sweep interval (deduplicated by interval bucket). No-op when
 * sweeps are off.
 */
export async function enqueueDueRetentionSweeps(
  db: Database,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<number> {
  const interval = retentionSweepIntervalSeconds(env);
  if (!interval) return 0;
  const bucket = Math.floor(now.getTime() / 1000 / interval);
  const orgs = await organizationsWithRetention(db);
  let created = 0;
  for (const organizationId of orgs) {
    // System context: the scheduler acts for no user; the job is tenant-scoped by organization_id.
    const res = await withSystemContext(db, (tx) =>
      enqueueJob(tx, {
        organizationId,
        kind: "apply_retention",
        payload: {},
        dedupeKey: `apply_retention:${organizationId}:${interval}:${bucket}`,
      }),
    );
    if (res.created) created++;
  }
  return created;
}

export interface RetentionScheduler {
  /** Enqueue due sweeps if the interval bucket changed since the last tick. Never throws. */
  tick(db: Database): Promise<void>;
}

/**
 * Cheap per-poll hook for job runners: does nothing while sweeps are off, and
 * otherwise touches the database once per sweep interval.
 */
export function createRetentionScheduler(env: Record<string, string | undefined> = process.env): RetentionScheduler {
  let lastBucket: number | null = null;
  return {
    async tick(db) {
      const interval = retentionSweepIntervalSeconds(env);
      if (!interval) return;
      const now = new Date();
      const bucket = Math.floor(now.getTime() / 1000 / interval);
      if (bucket === lastBucket) return;
      try {
        await enqueueDueRetentionSweeps(db, env, now);
        lastBucket = bucket;
      } catch (err) {
        logger.error("retention.schedule_failed", { errorName: err instanceof Error ? err.name : "unknown" });
      }
    },
  };
}

/** Job handler for `apply_retention`. */
export async function handleApplyRetention(db: Database, job: Job): Promise<void> {
  if (!job.organizationId) throw permanent("missing_organization");
  try {
    await applyRetention(db, job.organizationId);
  } catch (err) {
    if (err instanceof DomainError) throw permanent(`domain_${err.code}`);
    throw new JobError("retention_failed", true);
  }
}

/** CLI entry: apply every organization's policy once (`npm run retention:sweep`). */
export async function runRetentionSweepOnce(db?: Database): Promise<RetentionRunResult[]> {
  const target = db ?? (await getDatabase()).db;
  const out: RetentionRunResult[] = [];
  for (const org of await organizationsWithRetention(target)) out.push(await applyRetention(target, org));
  return out;
}
