/**
 * Private per-user reading state (`briefing_reads`): the last revision of a
 * briefing the viewer opened, used only for the viewer's own library
 * "Unread" / "New version" badges.
 *
 * This is the reader's own data, not author analytics. RLS limits every row
 * to its own user; nothing here is exposed to authors, admins or engagement
 * summaries, and it is unrelated to the pseudonymous engagement_events.
 */
import { briefingReads, briefingRevisions, type Database, type Tx } from "@cerebro/database";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { canReadRevision } from "../access/index";
import type { RequestContext } from "../context";
import { parseInput, Uuid, withCtx } from "../org/shared";

export const RecordBriefingReadInput = z
  .object({ briefingId: Uuid, revisionNumber: z.number().int().min(1) })
  .strict();
export type RecordBriefingReadInput = z.input<typeof RecordBriefingReadInput>;

export interface BriefingReadDto {
  briefingId: string;
  lastRevisionNumber: number;
  lastOpenedAt: Date;
}

/**
 * Record that the viewer opened `revisionNumber`. Requires read access to
 * that revision; returns false (and writes nothing) otherwise. The stored
 * revision never moves backwards, so opening an older pinned version does not
 * mark a newer one as read.
 */
export async function recordBriefingReadInTx(tx: Tx, ctx: RequestContext, raw: RecordBriefingReadInput): Promise<boolean> {
  const input = parseInput(RecordBriefingReadInput, raw);
  const [rev] = await tx
    .select({ id: briefingRevisions.id })
    .from(briefingRevisions)
    .where(
      and(
        eq(briefingRevisions.organizationId, ctx.organizationId),
        eq(briefingRevisions.briefingId, input.briefingId),
        eq(briefingRevisions.number, input.revisionNumber),
      ),
    );
  if (!rev || !(await canReadRevision(tx, ctx, input.briefingId, rev.id))) return false;
  await tx
    .insert(briefingReads)
    .values({
      organizationId: ctx.organizationId,
      briefingId: input.briefingId,
      userId: ctx.userId,
      lastRevisionNumber: input.revisionNumber,
    })
    .onConflictDoUpdate({
      target: [briefingReads.organizationId, briefingReads.briefingId, briefingReads.userId],
      set: {
        lastRevisionNumber: sql`greatest(${briefingReads.lastRevisionNumber}, excluded.last_revision_number)`,
        lastOpenedAt: sql`now()`,
      },
    });
  return true;
}

export const recordBriefingRead = (db: Database, ctx: RequestContext, input: RecordBriefingReadInput) =>
  withCtx(db, ctx, (tx, c) => recordBriefingReadInTx(tx, c, input));

/** The viewer's own reading state for one briefing, or null if never opened. */
export const getMyBriefingRead = (db: Database, ctx: RequestContext, briefingId: string) =>
  withCtx(db, ctx, async (tx, c): Promise<BriefingReadDto | null> => {
    const id = parseInput(Uuid, briefingId);
    const [row] = await tx
      .select()
      .from(briefingReads)
      .where(
        and(
          eq(briefingReads.organizationId, c.organizationId),
          eq(briefingReads.briefingId, id),
          eq(briefingReads.userId, c.userId),
        ),
      );
    return row ? { briefingId: id, lastRevisionNumber: row.lastRevisionNumber, lastOpenedAt: row.lastOpenedAt } : null;
  });
