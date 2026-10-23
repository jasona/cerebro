/**
 * Test-only fixtures for engagement, sources and jobs tests. Inserts published
 * revisions directly under the system context (the publication module owns
 * the real publish transaction).
 */
import { randomUUID } from "node:crypto";
import { strategyBriefing, toPublishedDocument, type BriefingDocument } from "@cerebro/briefing-schema";
import {
  briefingDrafts,
  briefingRevisions,
  briefings,
  publications,
  revisionEvidence,
  withSystemContext,
  type SeedUserKey,
  type Visibility,
} from "@cerebro/database";
import { eq } from "drizzle-orm";
import { enqueueIndexRevision } from "../jobs/kinds";
import { runJobsOnce } from "../jobs/runner";
import type { TestWorld } from "../testing";

export interface FixtureBriefing {
  id: string;
  organizationId: string;
  revisions: { id: string; number: number }[];
}

export async function makePublishedBriefing(
  w: TestWorld,
  opts: { owner?: SeedUserKey; org?: "acme" | "globex"; visibility?: Visibility; doc?: BriefingDocument; withDraft?: boolean } = {},
): Promise<FixtureBriefing> {
  const org = w.seed.orgs[opts.org ?? "acme"];
  const ownerId = w.seed.users[opts.owner ?? "maya"];
  const doc = opts.doc ?? strategyBriefing;
  return withSystemContext(w.h.db, async (tx) => {
    const [b] = await tx
      .insert(briefings)
      .values({
        organizationId: org.id,
        ownerId,
        title: doc.title,
        slug: `b-${randomUUID()}`,
        visibility: opts.visibility ?? "company",
      })
      .returning({ id: briefings.id });
    if (opts.withDraft ?? true) {
      await tx.insert(briefingDrafts).values({
        organizationId: org.id,
        briefingId: b!.id,
        documentJson: doc,
        schemaVersion: doc.schemaVersion,
        updatedBy: ownerId,
      });
    }
    return { id: b!.id, organizationId: org.id, revisions: [] };
  }).then(async (fb) => {
    await publishRevision(w, fb, { doc, publisher: opts.owner ?? "maya" });
    return fb;
  });
}

/** Seal `doc` as the next revision, publish it and make it current. Does not index it. */
export async function publishRevision(
  w: TestWorld,
  fb: FixtureBriefing,
  opts: { doc?: BriefingDocument; publisher?: SeedUserKey; enqueueIndex?: boolean } = {},
): Promise<{ id: string; number: number }> {
  const publisher = w.seed.users[opts.publisher ?? "maya"];
  const projection = toPublishedDocument(opts.doc ?? strategyBriefing);
  return withSystemContext(w.h.db, async (tx) => {
    const number = fb.revisions.length + 1;
    const [r] = await tx
      .insert(briefingRevisions)
      .values({
        organizationId: fb.organizationId,
        briefingId: fb.id,
        number,
        documentJson: projection.document,
        schemaVersion: projection.document.schemaVersion,
        contentHash: `fixture-${randomUUID()}`,
        createdBy: publisher,
      })
      .returning({ id: briefingRevisions.id });
    for (const ev of projection.approvedEvidence) {
      await tx.insert(revisionEvidence).values({
        organizationId: fb.organizationId,
        revisionId: r!.id,
        evidenceKey: ev.id,
        title: ev.title,
        excerpt: ev.excerpt,
        attribution: ev.attribution ?? null,
        locator: ev.locator ?? null,
        origin: ev.origin,
        excerptHash: `h-${ev.id}`,
      });
    }
    const [p] = await tx
      .insert(publications)
      .values({ organizationId: fb.organizationId, briefingId: fb.id, revisionId: r!.id, publishedBy: publisher })
      .returning({ id: publications.id });
    await tx.update(briefings).set({ currentPublicationId: p!.id }).where(eq(briefings.id, fb.id));
    if (opts.enqueueIndex ?? true) {
      await enqueueIndexRevision(tx, { organizationId: fb.organizationId, briefingId: fb.id, revisionId: r!.id });
    }
    const rev = { id: r!.id, number };
    fb.revisions.push(rev);
    return rev;
  });
}

/** Drain all runnable jobs. */
export async function drainJobs(w: TestWorld): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await runJobsOnce(w.h.db, { workerId: "test-worker", limit: 10 });
    if (res.claimed === 0) return;
  }
}
