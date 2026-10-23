import { passagesFromDocument } from "@cerebro/ai";
import { PublishedBriefingDocument } from "@cerebro/briefing-schema";
import {
  briefingRevisions,
  publications,
  retrievalChunks,
  revisionEvidence,
  withAuthContext,
  withSystemContext,
  type Database,
  type Job,
} from "@cerebro/database";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canReadRevision } from "../access/index";
import { recordAudit } from "../audit";
import { allowedEmbeddings, getAiRuntimeOrNull, resolveOrgAiPolicy } from "../engagement/ai-runtime";
import { permanent, requireJobOrg, workerContext } from "./errors";
import { enqueueEmbedRevision } from "./kinds";

export const RevisionJobPayload = z.object({ revisionId: z.string().uuid(), briefingId: z.string().uuid() });
const Payload = RevisionJobPayload;

/**
 * Users a revision job may act as: who published, then who created the
 * revision. System context (justified): the worker serves every organization
 * and must find a user to act as before it can open an auth context. Reads
 * two ids only.
 */
export async function revisionJobActors(db: Database, organizationId: string, briefingId: string, revisionId: string): Promise<string[]> {
  return withSystemContext(db, async (tx) => {
    const rows = await tx
      .select({ createdBy: briefingRevisions.createdBy, publishedBy: publications.publishedBy })
      .from(briefingRevisions)
      .leftJoin(
        publications,
        and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)),
      )
      .where(
        and(
          eq(briefingRevisions.organizationId, organizationId),
          eq(briefingRevisions.id, revisionId),
          eq(briefingRevisions.briefingId, briefingId),
        ),
      );
    const row = rows[0];
    return row ? [...new Set([row.publishedBy, row.createdBy].filter((x): x is string => !!x))] : [];
  });
}

/**
 * Build the reader retrieval projection for one published revision.
 *
 * Corpus: the sealed revision document (parsed with PublishedBriefingDocument,
 * evidence omitted) plus that revision's `revision_evidence` rows, which hold
 * only approved excerpts. `source_chunks` are never read here.
 *
 * Authorization: the job is claimed under the system context. The handler
 * performs one narrow system lookup (who published/created the revision), then
 * reopens withAuthContext in the job's organization as that user and rechecks
 * `canReadRevision` before reading or writing anything.
 */
export async function handleIndexRevision(db: Database, job: Job): Promise<void> {
  const organizationId = requireJobOrg(job);
  const parsed = Payload.safeParse(job.payload);
  if (!parsed.success) throw permanent("invalid_payload");
  const { revisionId, briefingId } = parsed.data;

  const actors = await revisionJobActors(db, organizationId, briefingId, revisionId);
  if (actors.length === 0) throw permanent("revision_not_found");

  for (const userId of actors) {
    const ctx = workerContext(job, userId);
    const done = await withAuthContext(db, ctx, async (tx) => {
      if (!(await canReadRevision(tx, ctx, briefingId, revisionId))) return false;
      // Never index withdrawn content. The share lock serializes with
      // withdrawPublication (which locks the row FOR UPDATE and deletes chunks).
      const [pub] = await tx
        .select({ withdrawnAt: publications.withdrawnAt })
        .from(publications)
        .where(and(eq(publications.organizationId, organizationId), eq(publications.revisionId, revisionId)))
        .for("share");
      if (!pub || pub.withdrawnAt !== null) throw permanent("withdrawn");

      const [rev] = await tx
        .select({ documentJson: briefingRevisions.documentJson })
        .from(briefingRevisions)
        .where(and(eq(briefingRevisions.organizationId, organizationId), eq(briefingRevisions.id, revisionId)));
      if (!rev) throw permanent("revision_not_found");
      const doc = PublishedBriefingDocument.safeParse(rev.documentJson);
      if (!doc.success) throw permanent("invalid_document");

      const sectionOf = new Map<string, string>();
      for (const s of doc.data.sections) for (const b of s.blocks) sectionOf.set(b.id, s.id);

      // Document passages only; evidence comes from the approved evidence package below.
      const blockPassages = passagesFromDocument({ ...doc.data, evidence: [] }, revisionId).filter((p) => p.kind === "block");
      const evidence = await tx
        .select({ id: revisionEvidence.id, excerpt: revisionEvidence.excerpt, attribution: revisionEvidence.attribution })
        .from(revisionEvidence)
        .where(and(eq(revisionEvidence.organizationId, organizationId), eq(revisionEvidence.revisionId, revisionId)))
        .orderBy(revisionEvidence.createdAt, revisionEvidence.evidenceKey);

      let ordinal = 0;
      const rows: (typeof retrievalChunks.$inferInsert)[] = [];
      for (const p of blockPassages) {
        rows.push({
          organizationId,
          briefingId,
          revisionId,
          kind: "block",
          blockKey: p.id,
          sectionKey: sectionOf.get(p.id) ?? null,
          ordinal: ordinal++,
          text: p.text,
        });
      }
      for (const ev of evidence) {
        rows.push({
          organizationId,
          briefingId,
          revisionId,
          kind: "evidence",
          evidenceId: ev.id,
          ordinal: ordinal++,
          text: [ev.excerpt, ev.attribution ? `Source: ${ev.attribution}.` : undefined].filter(Boolean).join("\n\n"),
        });
      }

      // Replace atomically: readers see either the old projection or the new one.
      await tx
        .delete(retrievalChunks)
        .where(and(eq(retrievalChunks.organizationId, organizationId), eq(retrievalChunks.revisionId, revisionId)));
      if (rows.length) await tx.insert(retrievalChunks).values(rows);
      await recordAudit(tx, ctx, {
        action: "revision.indexed",
        targetType: "briefing",
        targetId: briefingId,
        revisionId,
        metadata: { blockChunks: blockPassages.length, evidenceChunks: evidence.length },
      });
      // Optional vector projection (W3.2): only when an embedding provider is
      // configured and this organization allows it. Same transaction, so the
      // embedding job sees exactly these chunks.
      const embeddings = rows.length ? allowedEmbeddings(await getAiRuntimeOrNull(), await resolveOrgAiPolicy(tx, organizationId)) : null;
      if (embeddings) {
        await enqueueEmbedRevision(tx, {
          organizationId,
          briefingId,
          revisionId,
          embeddingModel: `${embeddings.model}:${embeddings.dimensions}`,
        });
      }
      return true;
    });
    if (done) return;
  }
  throw permanent("forbidden");
}
