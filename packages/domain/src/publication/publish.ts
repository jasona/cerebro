/**
 * The publication transaction (SECURITY_AND_PUBLICATION.md) and withdrawal.
 */
import { createHash } from "node:crypto";
import {
  briefingDrafts,
  briefingRevisions,
  briefings,
  enqueueJob,
  publicationPreviews,
  publications,
  retrievalChunks,
  revisionEvidence,
  type Database,
  type Tx,
} from "@cerebro/database";
import { canonicalJson, documentDigest, SCHEMA_VERSION } from "@cerebro/briefing-schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import {
  canonicalPath,
  ensureReaderGrants,
  inAuthTx,
  loadBriefingRow,
  orgSlugOf,
  parseInput,
  pinnedPath,
  type ServiceOptions,
} from "../briefings/shared";
import { changeLines, computeBinding, currentPublishedDocument } from "./preview";

export const INDEX_REVISION_JOB = "index_revision";
/** Jobs' dedupe_key is global, so it carries the organization id. */
export const indexRevisionDedupeKey = (organizationId: string, revisionId: string) =>
  `${INDEX_REVISION_JOB}:${organizationId}:${revisionId}`;

export const PublishBriefingInput = z
  .object({
    briefingId: z.string().uuid(),
    previewId: z.string().uuid(),
    changeSummary: z.string().trim().min(1).max(2000).optional(),
    /** Client operation reference (e.g. MCP idempotency key); recorded in the audit trail. */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PublishBriefingInput = z.input<typeof PublishBriefingInput>;

export interface PublishBriefingResult {
  publicationId: string;
  revisionId: string;
  revisionNumber: number;
  publishedAt: Date;
  /** `/c/<orgSlug>/b/<slug>`: stable link to the latest publication. */
  canonicalPath: string;
  /** `/c/<orgSlug>/b/<slug>/v/<n>`. */
  pinnedPath: string;
  /** True when this preview had already been published and the original result is returned. */
  replayed: boolean;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function publicationResult(tx: Tx, ctx: RequestContext, publicationId: string, replayed: boolean): Promise<PublishBriefingResult> {
  const [r] = await tx
    .select({
      publicationId: publications.id,
      revisionId: publications.revisionId,
      publishedAt: publications.publishedAt,
      number: briefingRevisions.number,
      slug: briefings.slug,
    })
    .from(publications)
    .innerJoin(
      briefingRevisions,
      and(eq(briefingRevisions.organizationId, publications.organizationId), eq(briefingRevisions.id, publications.revisionId)),
    )
    .innerJoin(briefings, and(eq(briefings.organizationId, publications.organizationId), eq(briefings.id, publications.briefingId)))
    .where(and(eq(publications.organizationId, ctx.organizationId), eq(publications.id, publicationId)));
  if (!r) throw new DomainError("not_found", "Publication not found.");
  const orgSlug = await orgSlugOf(tx, ctx);
  return {
    publicationId: r.publicationId,
    revisionId: r.revisionId,
    revisionNumber: r.number,
    publishedAt: r.publishedAt,
    canonicalPath: canonicalPath(orgSlug, r.slug),
    pinnedPath: pinnedPath(orgSlug, r.slug, r.number),
    replayed,
  };
}

/**
 * Publish the exact reviewed draft, evidence, home and audience in ONE
 * transaction. Any error rolls everything back and leaves the previous
 * publication current. Re-publishing an already consumed preview returns the
 * original publication (`replayed: true`), never a second revision.
 */
export async function publishBriefingInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: PublishBriefingInput,
  opts: ServiceOptions<PublishBriefingResult> = {},
): Promise<PublishBriefingResult> {
  const input = parseInput(PublishBriefingInput, rawInput);

  // 1. Current publish capability (not whatever was true at preview time).
  await assertBriefingCapability(tx, ctx, input.briefingId, "publish");

  // Serialize publications of this briefing: lock the briefing row, then the preview.
  const b = await loadBriefingRow(tx, ctx, input.briefingId, { forUpdate: true });
  if (!b) throw new DomainError("not_found", "Briefing not found.");

  // 2. The preview: same org, actor and briefing; not expired; not consumed.
  const [preview] = await tx
    .select({
      p: publicationPreviews,
      expired: sql<boolean>`${publicationPreviews.expiresAt} <= now()`,
    })
    .from(publicationPreviews)
    .where(
      and(
        eq(publicationPreviews.organizationId, ctx.organizationId),
        eq(publicationPreviews.id, input.previewId),
        eq(publicationPreviews.briefingId, b.id),
        eq(publicationPreviews.actorId, ctx.userId),
      ),
    )
    .for("update");
  if (!preview) throw new DomainError("not_found", "Preview not found.");
  const p = preview.p;
  if (p.consumedAt !== null) {
    if (p.publicationId) {
      const result = await publicationResult(tx, ctx, p.publicationId, true);
      if (opts.operation) await opts.operation(tx, result);
      return result;
    }
    throw new DomainError("stale_preview", "This preview has already been used.", { reasons: ["consumed"] });
  }
  if (preview.expired) throw new DomainError("stale_preview", "This preview has expired. Preview the brief again.", { reasons: ["expired"] });

  // 3. Recompute the binding from the current draft, home and audience.
  const binding = await computeBinding(tx, ctx, b, { forUpdate: true });
  const reasons: string[] = [];
  if (binding.draftLockVersion !== p.draftLockVersion) reasons.push("draft_version");
  if (binding.contentDigest !== p.contentDigest) reasons.push("content");
  if (binding.evidenceDigest !== p.evidenceDigest) reasons.push("evidence");
  // The preview's change summary was reviewed against this publication.
  if (b.currentPublicationId !== p.basePublicationId) reasons.push("publication");
  if (binding.home.departmentId !== p.homeDepartmentId || binding.home.teamId !== p.homeTeamId) reasons.push("home");
  const snapReaders = ((p.audienceSnapshot as { readerUserIds?: string[] } | null)?.readerUserIds ?? []).slice().sort();
  if (
    binding.audience.visibility !== p.visibility ||
    binding.audience.departmentId !== p.audienceDepartmentId ||
    binding.audience.teamId !== p.audienceTeamId ||
    canonicalJson(binding.readerUserIds) !== canonicalJson(snapReaders)
  ) {
    reasons.push("audience");
  }
  if (reasons.length) {
    throw new DomainError("stale_preview", "The brief changed after this preview. Preview it again before publishing.", { reasons });
  }

  // 4. Validation: no errors allowed.
  const errors = binding.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new DomainError("validation", "The brief has errors that block publication.", { issues: errors });

  // 5. Immutable revision with the next number.
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`(coalesce(max(${briefingRevisions.number}), 0) + 1)::int` })
    .from(briefingRevisions)
    .where(and(eq(briefingRevisions.organizationId, ctx.organizationId), eq(briefingRevisions.briefingId, b.id)));
  const [revision] = await tx
    .insert(briefingRevisions)
    .values({
      organizationId: ctx.organizationId,
      briefingId: b.id,
      number: next,
      documentJson: binding.published,
      schemaVersion: SCHEMA_VERSION,
      contentHash: documentDigest(binding.published),
      createdBy: ctx.userId,
    })
    .returning();

  // 6. Approved evidence only; candidates and excluded items stay private.
  const sourceIds = new Map(binding.draft.evidence.map((e) => [e.id, e.sourceRef?.sourceId ?? null]));
  if (binding.approvedEvidence.length) {
    await tx.insert(revisionEvidence).values(
      binding.approvedEvidence.map((e) => ({
        organizationId: ctx.organizationId,
        revisionId: revision!.id,
        evidenceKey: e.id,
        title: e.title,
        excerpt: e.excerpt,
        attribution: e.attribution ?? null,
        locator: e.locator ?? null,
        origin: e.origin,
        sourceId: sourceIds.get(e.id) ?? null,
        excerptHash: sha256(e.excerpt),
      })),
    );
  }

  // 7. Publication record.
  const current = await currentPublishedDocument(tx, ctx, b);
  const changeSummary = input.changeSummary ?? changeLines(current, binding.published).lines.slice(0, 8).join("\n").slice(0, 2000);
  const [publication] = await tx
    .insert(publications)
    .values({
      organizationId: ctx.organizationId,
      briefingId: b.id,
      revisionId: revision!.id,
      publishedBy: ctx.userId,
      changeSummary,
      connectionId: ctx.connectionId ?? null,
    })
    .returning();

  // 8. Move the current pointer; library title/summary follow the published document.
  await tx
    .update(briefings)
    .set({
      currentPublicationId: publication!.id,
      title: binding.published.title,
      summary: binding.published.position.summary.slice(0, 1000),
      updatedAt: sql`now()`,
    })
    .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, b.id)));
  await tx
    .update(briefingDrafts)
    .set({ baseRevisionId: revision!.id })
    .where(and(eq(briefingDrafts.organizationId, ctx.organizationId), eq(briefingDrafts.briefingId, b.id)));

  // 9. Named-reader grants of the reviewed audience. They already exist (the
  // preview snapshot was compared above); this keeps the step explicit.
  await ensureReaderGrants(tx, ctx, b.id, snapReaders);

  // 10. Consume the preview.
  await tx
    .update(publicationPreviews)
    .set({ consumedAt: sql`now()`, publicationId: publication!.id })
    .where(and(eq(publicationPreviews.organizationId, ctx.organizationId), eq(publicationPreviews.id, p.id)));

  // 11. Audit: actor, connection (via recordAudit), operation reference. No content.
  await recordAudit(tx, ctx, {
    action: "briefing.published",
    targetType: "briefing",
    targetId: b.id,
    revisionId: revision!.id,
    metadata: {
      publicationId: publication!.id,
      revisionNumber: next,
      previewId: p.id,
      via: ctx.via,
      operationRef: input.idempotencyKey ?? ctx.requestId,
      visibility: binding.audience.visibility,
      approvedEvidence: binding.approvedEvidence.length,
      droppedRefs: binding.droppedRefs.length,
    },
  });

  // 12. Index the revision for Q&A retrieval (same transaction).
  await enqueueJob(tx, {
    organizationId: ctx.organizationId,
    kind: INDEX_REVISION_JOB,
    payload: { briefingId: b.id, revisionId: revision!.id },
    dedupeKey: indexRevisionDedupeKey(ctx.organizationId, revision!.id),
  });

  const result = await publicationResult(tx, ctx, publication!.id, false);
  if (opts.operation) await opts.operation(tx, result);
  return result;
}

export function publishBriefing(
  db: Database,
  ctx: RequestContext,
  input: PublishBriefingInput,
  opts?: ServiceOptions<PublishBriefingResult>,
): Promise<PublishBriefingResult> {
  return inAuthTx(db, ctx, (tx, c) => publishBriefingInTx(tx, c, input, opts));
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

export const WithdrawPublicationInput = z.object({ briefingId: z.string().uuid(), publicationId: z.string().uuid() }).strict();
export type WithdrawPublicationInput = z.input<typeof WithdrawPublicationInput>;

export interface WithdrawPublicationResult {
  publicationId: string;
  withdrawnAt: Date;
  /** True when this was the current publication and the pointer was cleared. */
  clearedCurrent: boolean;
  /** False when the publication had already been withdrawn. */
  changed: boolean;
  /** Earlier publications withdrawn with it (D16: withdrawing the current one withdraws the brief). */
  alsoWithdrawn: number;
}

/**
 * Withdraw a publication without rewriting its snapshot. Clears the current
 * pointer when it was current; never auto-promotes an earlier revision.
 * Withdrawing the current publication withdraws the brief (D16): every earlier
 * publication still active is withdrawn too, so pinned links to older
 * revisions show the withdrawn state. Irreversible (the database forbids
 * restoring `withdrawn_at`); publishing again creates a new publication.
 */
export async function withdrawPublicationInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: WithdrawPublicationInput,
  opts: ServiceOptions<WithdrawPublicationResult> = {},
): Promise<WithdrawPublicationResult> {
  const input = parseInput(WithdrawPublicationInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "withdraw");
  const b = await loadBriefingRow(tx, ctx, input.briefingId, { forUpdate: true });
  if (!b) throw new DomainError("not_found", "Briefing not found.");
  const [pub] = await tx
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.organizationId, ctx.organizationId),
        eq(publications.briefingId, b.id),
        eq(publications.id, input.publicationId),
      ),
    )
    .for("update");
  if (!pub) throw new DomainError("not_found", "Publication not found.");

  let result: WithdrawPublicationResult;
  if (pub.withdrawnAt !== null) {
    result = { publicationId: pub.id, withdrawnAt: pub.withdrawnAt, clearedCurrent: false, changed: false, alsoWithdrawn: 0 };
  } else {
    const isCurrent = b.currentPublicationId === pub.id;
    // Clear the pointer first so it never references a withdrawn publication.
    if (isCurrent) {
      await tx
        .update(briefings)
        .set({ currentPublicationId: null, updatedAt: sql`now()` })
        .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, b.id)));
    }
    const [updated] = await tx
      .update(publications)
      .set({ withdrawnAt: sql`now()` })
      .where(and(eq(publications.organizationId, ctx.organizationId), eq(publications.id, pub.id)))
      .returning({ withdrawnAt: publications.withdrawnAt });
    // Derived reader index: make the withdrawn revision unavailable to Q&A.
    await tx
      .delete(retrievalChunks)
      .where(and(eq(retrievalChunks.organizationId, ctx.organizationId), eq(retrievalChunks.revisionId, pub.revisionId)));
    await recordAudit(tx, ctx, {
      action: "publication.withdrawn",
      targetType: "briefing",
      targetId: b.id,
      revisionId: pub.revisionId,
      metadata: { publicationId: pub.id, wasCurrent: isCurrent },
    });
    let alsoWithdrawn = 0;
    if (isCurrent) {
      const earlier = await tx
        .update(publications)
        .set({ withdrawnAt: sql`now()` })
        .where(
          and(
            eq(publications.organizationId, ctx.organizationId),
            eq(publications.briefingId, b.id),
            ne(publications.id, pub.id),
            isNull(publications.withdrawnAt),
          ),
        )
        .returning({ id: publications.id, revisionId: publications.revisionId });
      for (const e of earlier) {
        await tx
          .delete(retrievalChunks)
          .where(and(eq(retrievalChunks.organizationId, ctx.organizationId), eq(retrievalChunks.revisionId, e.revisionId)));
        await recordAudit(tx, ctx, {
          action: "publication.withdrawn",
          targetType: "briefing",
          targetId: b.id,
          revisionId: e.revisionId,
          metadata: { publicationId: e.id, wasCurrent: false, withdrawnWith: pub.id },
        });
      }
      alsoWithdrawn = earlier.length;
    }
    result = { publicationId: pub.id, withdrawnAt: updated!.withdrawnAt!, clearedCurrent: isCurrent, changed: true, alsoWithdrawn };
  }
  if (opts.operation) await opts.operation(tx, result);
  return result;
}

export function withdrawPublication(
  db: Database,
  ctx: RequestContext,
  input: WithdrawPublicationInput,
  opts?: ServiceOptions<WithdrawPublicationResult>,
): Promise<WithdrawPublicationResult> {
  return inAuthTx(db, ctx, (tx, c) => withdrawPublicationInTx(tx, c, input, opts));
}
