/**
 * Publication previews: a server-issued reference bound to the actor, draft
 * version, content + evidence digest, home, audience (including named
 * readers) and an expiry. A preview proves what was prepared, not that a
 * human approved it (LLM_INTEGRATION.md "Preview and publication integrity").
 */
import { briefingRevisions, publicationPreviews, publications, type Database, type Tx } from "@cerebro/database";
import {
  collectIssues,
  diffDocuments,
  documentDigest,
  toPublishedDocument,
  type BriefingDocument,
  type DocumentDiff,
  type DocumentIssue,
  type DroppedRef,
  type PublishedBriefingDocument,
  type PublishedEvidenceItem,
} from "@cerebro/briefing-schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { loadDraftRow, parseStoredDraft } from "../briefings/drafts";
import { parseRevisionDocument } from "../briefings/reading";
import {
  activeReaderIds,
  audienceOf,
  describePlacement,
  homeOf,
  inAuthTx,
  loadBriefingRow,
  parseInput,
  type AudienceDTO,
  type BriefingRow,
  type HomeDTO,
  type ResolvedAudience,
  type ResolvedHome,
} from "../briefings/shared";

/** Preview lifetime. Provisional implementation setting (not an agreed product target). */
export const PREVIEW_TTL_MINUTES = 30;

export interface PreviewBinding {
  draft: BriefingDocument;
  draftLockVersion: number;
  published: PublishedBriefingDocument;
  approvedEvidence: PublishedEvidenceItem[];
  droppedRefs: DroppedRef[];
  contentDigest: string;
  evidenceDigest: string;
  home: ResolvedHome;
  audience: ResolvedAudience;
  readerUserIds: string[];
  issues: DocumentIssue[];
}

/** Compute everything a preview binds to, from the current draft and briefing row. */
export async function computeBinding(tx: Tx, ctx: RequestContext, b: BriefingRow, opts: { forUpdate?: boolean } = {}): Promise<PreviewBinding> {
  const row = await loadDraftRow(tx, ctx, b.id, opts);
  const draft = parseStoredDraft(row.documentJson);
  const projection = toPublishedDocument(draft);
  return {
    draft,
    draftLockVersion: row.lockVersion,
    published: projection.document,
    approvedEvidence: projection.approvedEvidence,
    droppedRefs: projection.droppedRefs,
    contentDigest: documentDigest(projection.document),
    // Every candidate's content and approval state: approve/exclude changes invalidate previews
    // even when the published projection would be unchanged.
    evidenceDigest: documentDigest(draft.evidence),
    home: homeOf(b),
    audience: audienceOf(b),
    readerUserIds: await activeReaderIds(tx, ctx, b.id),
    issues: collectIssues(draft, { mode: "publish" }),
  };
}

export interface PreviewEvidenceDTO {
  id: string;
  title: string;
  excerpt: string;
  attribution: string | null;
  origin: string;
  status: "approved" | "candidate" | "excluded";
}

export interface CreatePreviewResult {
  previewId: string;
  briefingId: string;
  draftVersion: number;
  /** The published projection: exactly what readers would receive. */
  document: PublishedBriefingDocument;
  home: HomeDTO;
  /** Includes `namedReaders` (the explicit recipient grants being released to). */
  audience: AudienceDTO;
  includedSections: { id: string; title: string; blockCount: number }[];
  evidence: { approved: PreviewEvidenceDTO[]; candidates: PreviewEvidenceDTO[]; excluded: PreviewEvidenceDTO[] };
  /** Claims publishing without evidence (references to candidate/excluded/missing evidence are removed). */
  droppedRefs: DroppedRef[];
  /** collectIssues in publish mode on the draft. Any `severity: "error"` blocks publication. */
  issues: DocumentIssue[];
  canPublish: boolean;
  /** Human-readable change lines vs the current publication (or a first-publication line). */
  changeSummary: string[];
  diff: DocumentDiff | null;
  currentRevisionNumber: number | null;
  expiresAt: Date;
}

export const CreatePreviewInput = z
  .object({ briefingId: z.string().uuid(), expectedVersion: z.number().int().min(1).optional() })
  .strict();
export type CreatePreviewInput = z.input<typeof CreatePreviewInput>;

export async function currentPublishedDocument(tx: Tx, ctx: RequestContext, b: BriefingRow) {
  if (!b.currentPublicationId) return null;
  const [r] = await tx
    .select({ number: briefingRevisions.number, json: briefingRevisions.documentJson })
    .from(publications)
    .innerJoin(
      briefingRevisions,
      and(eq(briefingRevisions.organizationId, publications.organizationId), eq(briefingRevisions.id, publications.revisionId)),
    )
    .where(
      and(
        eq(publications.organizationId, ctx.organizationId),
        eq(publications.id, b.currentPublicationId),
        sql`${publications.withdrawnAt} is null`,
      ),
    );
  return r ? { number: r.number, document: parseRevisionDocument(r.json) } : null;
}

export function changeLines(current: { document: PublishedBriefingDocument } | null, next: PublishedBriefingDocument) {
  if (!current) return { lines: ["First publication."], diff: null };
  const diff = diffDocuments(current.document, next);
  return { lines: diff.hasChanges ? diff.summary : ["No content changes since the current publication."], diff };
}

export async function createPreviewInTx(tx: Tx, ctx: RequestContext, rawInput: CreatePreviewInput): Promise<CreatePreviewResult> {
  const input = parseInput(CreatePreviewInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "publish");
  const b = await loadBriefingRow(tx, ctx, input.briefingId);
  if (!b) throw new DomainError("not_found", "Briefing not found.");
  const binding = await computeBinding(tx, ctx, b);
  if (input.expectedVersion !== undefined && input.expectedVersion !== binding.draftLockVersion) {
    throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: binding.draftLockVersion });
  }

  const [row] = await tx
    .insert(publicationPreviews)
    .values({
      organizationId: ctx.organizationId,
      briefingId: b.id,
      actorId: ctx.userId,
      connectionId: ctx.connectionId ?? null,
      draftLockVersion: binding.draftLockVersion,
      contentDigest: binding.contentDigest,
      evidenceDigest: binding.evidenceDigest,
      homeDepartmentId: binding.home.departmentId,
      homeTeamId: binding.home.teamId,
      visibility: binding.audience.visibility,
      audienceDepartmentId: binding.audience.departmentId,
      audienceTeamId: binding.audience.teamId,
      audienceSnapshot: { readerUserIds: binding.readerUserIds },
      basePublicationId: b.currentPublicationId,
      expiresAt: sql`now() + make_interval(mins => ${PREVIEW_TTL_MINUTES})`,
    })
    .returning({ id: publicationPreviews.id, expiresAt: publicationPreviews.expiresAt });

  const placement = await describePlacement(tx, ctx, binding.home, binding.audience, binding.readerUserIds);
  const ev = (status: PreviewEvidenceDTO["status"]) =>
    binding.draft.evidence
      .filter((e) => (e.status ?? "candidate") === status)
      .map((e) => ({
        id: e.id,
        title: e.title,
        excerpt: e.excerpt,
        attribution: e.attribution ?? null,
        origin: e.origin,
        status,
      }));
  const current = await currentPublishedDocument(tx, ctx, b);
  const { lines, diff } = changeLines(current, binding.published);
  return {
    previewId: row!.id,
    briefingId: b.id,
    draftVersion: binding.draftLockVersion,
    document: binding.published,
    home: placement.home,
    audience: placement.audience,
    includedSections: binding.published.sections.map((s) => ({ id: s.id, title: s.title, blockCount: s.blocks.length })),
    evidence: { approved: ev("approved"), candidates: ev("candidate"), excluded: ev("excluded") },
    droppedRefs: binding.droppedRefs,
    issues: binding.issues,
    canPublish: !binding.issues.some((i) => i.severity === "error"),
    changeSummary: lines,
    diff,
    currentRevisionNumber: current?.number ?? null,
    expiresAt: row!.expiresAt,
  };
}

export function createPreview(db: Database, ctx: RequestContext, input: CreatePreviewInput): Promise<CreatePreviewResult> {
  return inAuthTx(db, ctx, (tx, c) => createPreviewInTx(tx, c, input));
}
