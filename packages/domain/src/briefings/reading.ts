/**
 * Reader-facing and author-facing reads: briefing metadata, revision history,
 * sealed revision documents, revision comparison.
 *
 * Reader DTOs carry only published content: documents are parsed with
 * `PublishedBriefingDocument` (draft-only `status` / `sourceRef` stripped) and
 * evidence comes from `revision_evidence` without private `source_id`.
 */
import {
  briefingDrafts,
  briefingRevisions,
  briefings,
  publications,
  revisionEvidence,
  users,
  type Database,
  type Tx,
} from "@cerebro/database";
import {
  diffDocuments,
  PublishedBriefingDocument,
  toPublishedDocument,
  type DocumentDiff,
} from "@cerebro/briefing-schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assertBriefingCapability,
  canReadRevision,
  resolveBriefingAccess,
  type BriefingAccess,
  type Capability,
} from "../access/index";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { loadDraftRow, parseStoredDraft } from "./drafts";
import {
  activeReaderIds,
  audienceOf,
  BriefingLocator,
  canonicalPath,
  describePlacement,
  homeOf,
  inAuthTx,
  loadBriefingRow,
  orgSlugOf,
  parseInput,
  pinnedPath,
  resolveBriefingId,
  userRefs,
  type AudienceDTO,
  type HomeDTO,
  type UserRef,
} from "./shared";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface CurrentPublicationDTO {
  publicationId: string;
  revisionId: string;
  revisionNumber: number;
  publishedAt: Date;
}

export interface BriefingMetaDTO {
  briefingId: string;
  slug: string;
  /** Published title (or the draft title before first publication, visible only to collaborators). */
  title: string;
  summary: string | null;
  home: HomeDTO;
  audience: AudienceDTO;
  owner: UserRef;
  currentPublication: CurrentPublicationDTO | null;
  capabilities: Capability[];
  canonicalPath: string;
  archived: boolean;
  /** Present only for viewers holding view_draft. */
  draft?: { lockVersion: number; updatedAt: Date };
}

export interface RevisionSummaryDTO {
  revisionId: string;
  revisionNumber: number;
  publicationId: string;
  publishedAt: Date;
  publishedBy: UserRef;
  changeSummary: string | null;
  withdrawn: boolean;
  isCurrent: boolean;
}

/** Approved evidence as readers see it. Never includes private source references. */
export interface ReaderEvidenceDTO {
  id: string;
  title: string;
  excerpt: string;
  attribution: string | null;
  locator: string | null;
  origin: string;
}

export interface RevisionInfoDTO {
  revisionId: string;
  revisionNumber: number;
  publicationId: string;
  publishedAt: Date;
  changeSummary: string | null;
  isCurrent: boolean;
  schemaVersion: number;
  contentHash: string;
}

export interface RevisionDocumentDTO {
  briefingId: string;
  slug: string;
  title: string;
  revision: RevisionInfoDTO;
  document: PublishedBriefingDocument;
  evidence: ReaderEvidenceDTO[];
  /** True when the revision has no approved evidence: render "no supporting evidence attached". */
  noEvidence: boolean;
  capabilities: Capability[];
  canonicalPath: string;
  pinnedPath: string;
}

export interface CompareRevisionsResult {
  briefingId: string;
  from: { revisionNumber: number };
  to: { revisionNumber: number } | { draft: true; lockVersion: number };
  diff: DocumentDiff;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const capList = (a: BriefingAccess) => [...a.capabilities].sort();

async function requireRead(tx: Tx, ctx: RequestContext, briefingId: string): Promise<BriefingAccess> {
  const access = await resolveBriefingAccess(tx, ctx, briefingId);
  if (!access || !access.capabilities.has("read")) throw new DomainError("not_found", "Briefing not found.");
  return access;
}

/**
 * Whether the viewer may learn that a briefing's publication was withdrawn
 * (a "withdrawn" state without content, ACCESS_MATRIX.md share links). True
 * for collaborators, holders of any active grant on the briefing, and active
 * members who are in its audience. Everyone else gets a plain not_found, so
 * the withdrawn state never discloses that an inaccessible briefing exists.
 */
export async function mayKnowWithdrawn(tx: Tx, ctx: RequestContext, briefingId: string): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(sql`
    select (
      b.owner_id = ${ctx.userId}::uuid
      or exists (select 1 from briefing_grants g
                 where g.organization_id = b.organization_id and g.briefing_id = b.id
                   and g.user_id = ${ctx.userId}::uuid and g.revoked_at is null)
      or (exists (select 1 from memberships m
                  where m.organization_id = b.organization_id and m.user_id = ${ctx.userId}::uuid and m.status = 'active')
          and (b.visibility = 'company'
            or (b.visibility = 'department' and (
              exists (select 1 from department_memberships dm
                      where dm.organization_id = b.organization_id and dm.department_id = b.audience_department_id
                        and dm.user_id = ${ctx.userId}::uuid and dm.status = 'active')
              or exists (select 1 from team_memberships tm join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
                         where tm.organization_id = b.organization_id and t.department_id = b.audience_department_id
                           and tm.user_id = ${ctx.userId}::uuid and tm.status = 'active')))
            or (b.visibility = 'team' and exists (select 1 from team_memberships tm
                      where tm.organization_id = b.organization_id and tm.team_id = b.audience_team_id
                        and tm.user_id = ${ctx.userId}::uuid and tm.status = 'active'))))
    ) as ok
    from briefings b
    where b.id = ${briefingId}::uuid and b.organization_id = ${ctx.organizationId}::uuid`);
  return res.rows[0]?.ok === true;
}

export async function withdrawnOrNotFound(tx: Tx, ctx: RequestContext, briefingId: string, hasWithdrawn: boolean): Promise<never> {
  if (hasWithdrawn && (await mayKnowWithdrawn(tx, ctx, briefingId))) {
    throw new DomainError("not_found", "This publication has been withdrawn.", { reason: "withdrawn" });
  }
  throw new DomainError("not_found", "Briefing not found.");
}

async function anyWithdrawnPublication(tx: Tx, ctx: RequestContext, briefingId: string): Promise<boolean> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(publications)
    .where(
      and(
        eq(publications.organizationId, ctx.organizationId),
        eq(publications.briefingId, briefingId),
        sql`${publications.withdrawnAt} is not null`,
      ),
    );
  return (r?.n ?? 0) > 0;
}

async function revisionWithPublication(tx: Tx, ctx: RequestContext, briefingId: string, where: { number?: number; id?: string }) {
  const rows = await tx
    .select({ r: briefingRevisions, p: publications })
    .from(briefingRevisions)
    .innerJoin(
      publications,
      and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)),
    )
    .where(
      and(
        eq(briefingRevisions.organizationId, ctx.organizationId),
        eq(briefingRevisions.briefingId, briefingId),
        where.number !== undefined ? eq(briefingRevisions.number, where.number) : undefined,
        where.id !== undefined ? eq(briefingRevisions.id, where.id) : undefined,
      ),
    );
  return rows[0] ?? null;
}

/** Parse sealed revision JSON. Always `PublishedBriefingDocument`, never `BriefingDocument`. */
export const parseRevisionDocument = (json: unknown): PublishedBriefingDocument => PublishedBriefingDocument.parse(json);

async function readerEvidence(tx: Tx, ctx: RequestContext, revisionId: string): Promise<ReaderEvidenceDTO[]> {
  return tx
    .select({
      id: revisionEvidence.evidenceKey,
      title: revisionEvidence.title,
      excerpt: revisionEvidence.excerpt,
      attribution: revisionEvidence.attribution,
      locator: revisionEvidence.locator,
      origin: revisionEvidence.origin,
    })
    .from(revisionEvidence)
    .where(and(eq(revisionEvidence.organizationId, ctx.organizationId), eq(revisionEvidence.revisionId, revisionId)))
    .orderBy(asc(revisionEvidence.createdAt), asc(revisionEvidence.evidenceKey));
}

// ---------------------------------------------------------------------------
// getBriefingMeta
// ---------------------------------------------------------------------------

export async function getBriefingMetaInTx(tx: Tx, ctx: RequestContext, rawLocator: BriefingLocator): Promise<BriefingMetaDTO> {
  const locator = parseInput(BriefingLocator, rawLocator);
  const id = await resolveBriefingId(tx, ctx, locator);
  const access = await resolveBriefingAccess(tx, ctx, id);
  if (!access || !access.capabilities.has("read")) {
    // A briefing whose only publication was withdrawn: say so to people who could read it.
    if (access) await withdrawnOrNotFound(tx, ctx, id, await anyWithdrawnPublication(tx, ctx, id));
    throw new DomainError("not_found", "Briefing not found.");
  }
  const b = (await loadBriefingRow(tx, ctx, id))!;
  const seesAudience = access.capabilities.has("manage_access") || access.capabilities.has("publish");
  const placement = await describePlacement(
    tx,
    ctx,
    homeOf(b),
    audienceOf(b),
    seesAudience ? await activeReaderIds(tx, ctx, id) : undefined,
  );
  const [owner] = await userRefs(tx, [b.ownerId]);

  let currentPublication: CurrentPublicationDTO | null = null;
  if (access.currentRevisionId) {
    const rp = await revisionWithPublication(tx, ctx, id, { id: access.currentRevisionId });
    if (rp) {
      currentPublication = {
        publicationId: rp.p.id,
        revisionId: rp.r.id,
        revisionNumber: rp.r.number,
        publishedAt: rp.p.publishedAt,
      };
    }
  }
  const dto: BriefingMetaDTO = {
    briefingId: id,
    slug: b.slug,
    title: b.title,
    summary: b.summary,
    home: placement.home,
    audience: placement.audience,
    owner: owner!,
    currentPublication,
    capabilities: capList(access),
    canonicalPath: canonicalPath(await orgSlugOf(tx, ctx), b.slug),
    archived: b.archivedAt !== null,
  };
  if (access.capabilities.has("view_draft")) {
    const [d] = await tx
      .select({ lockVersion: briefingDrafts.lockVersion, updatedAt: briefingDrafts.updatedAt })
      .from(briefingDrafts)
      .where(and(eq(briefingDrafts.organizationId, ctx.organizationId), eq(briefingDrafts.briefingId, id)));
    if (d) dto.draft = d;
  }
  return dto;
}

export function getBriefingMeta(db: Database, ctx: RequestContext, locator: BriefingLocator): Promise<BriefingMetaDTO> {
  return inAuthTx(db, ctx, (tx, c) => getBriefingMetaInTx(tx, c, locator));
}

// ---------------------------------------------------------------------------
// listRevisions
// ---------------------------------------------------------------------------

/**
 * Published revisions, newest first. Collaborators see every revision with
 * withdrawn flags; other readers see the revisions they may read (withdrawn
 * revisions are omitted for them, since no content or summary is available).
 */
export async function listRevisionsInTx(tx: Tx, ctx: RequestContext, briefingId: string): Promise<RevisionSummaryDTO[]> {
  const id = parseInput(z.string().uuid(), briefingId);
  const access = await requireRead(tx, ctx, id);
  const collaborator = access.roles.length > 0;
  const [b] = await tx
    .select({ current: briefings.currentPublicationId })
    .from(briefings)
    .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, id)));
  const rows = await tx
    .select({
      revisionId: briefingRevisions.id,
      revisionNumber: briefingRevisions.number,
      publicationId: publications.id,
      publishedAt: publications.publishedAt,
      publishedById: publications.publishedBy,
      publishedByName: users.displayName,
      changeSummary: publications.changeSummary,
      withdrawnAt: publications.withdrawnAt,
    })
    .from(briefingRevisions)
    .innerJoin(
      publications,
      and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)),
    )
    .leftJoin(users, eq(users.id, publications.publishedBy))
    .where(and(eq(briefingRevisions.organizationId, ctx.organizationId), eq(briefingRevisions.briefingId, id)))
    .orderBy(desc(briefingRevisions.number));
  const out: RevisionSummaryDTO[] = [];
  for (const r of rows) {
    if (!collaborator && (r.withdrawnAt !== null || !(await canReadRevision(tx, ctx, id, r.revisionId)))) continue;
    out.push({
      revisionId: r.revisionId,
      revisionNumber: r.revisionNumber,
      publicationId: r.publicationId,
      publishedAt: r.publishedAt,
      publishedBy: { userId: r.publishedById, displayName: r.publishedByName ?? "Unknown user" },
      changeSummary: r.changeSummary,
      withdrawn: r.withdrawnAt !== null,
      isCurrent: b?.current === r.publicationId,
    });
  }
  return out;
}

export function listRevisions(db: Database, ctx: RequestContext, briefingId: string): Promise<RevisionSummaryDTO[]> {
  return inAuthTx(db, ctx, (tx, c) => listRevisionsInTx(tx, c, briefingId));
}

// ---------------------------------------------------------------------------
// getRevisionDocument
// ---------------------------------------------------------------------------

export const GetRevisionDocumentInput = z
  .object({
    briefingId: z.string().uuid().optional(),
    slug: z.string().min(1).max(120).optional(),
    /** Pinned revision. Omit for the current publication. */
    revisionNumber: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.briefingId === undefined) !== (v.slug === undefined), { message: "Provide briefingId or slug." });
export type GetRevisionDocumentInput = z.input<typeof GetRevisionDocumentInput>;

/**
 * The current publication (default) or a pinned revision checked with
 * canReadRevision. A withdrawn publication throws not_found with
 * `details.reason = "withdrawn"` (no content) for viewers entitled to know.
 */
export async function getRevisionDocumentInTx(tx: Tx, ctx: RequestContext, rawInput: GetRevisionDocumentInput): Promise<RevisionDocumentDTO> {
  const input = parseInput(GetRevisionDocumentInput, rawInput);
  const id = await resolveBriefingId(tx, ctx, input.briefingId ? { briefingId: input.briefingId } : { slug: input.slug! });
  const access = await resolveBriefingAccess(tx, ctx, id);
  if (!access) throw new DomainError("not_found", "Briefing not found.");

  let rp: Awaited<ReturnType<typeof revisionWithPublication>>;
  if (input.revisionNumber === undefined) {
    if (!access.currentRevisionId || !access.capabilities.has("read")) {
      return withdrawnOrNotFound(tx, ctx, id, await anyWithdrawnPublication(tx, ctx, id));
    }
    rp = await revisionWithPublication(tx, ctx, id, { id: access.currentRevisionId });
  } else {
    rp = await revisionWithPublication(tx, ctx, id, { number: input.revisionNumber });
    if (!rp) return withdrawnOrNotFound(tx, ctx, id, false);
    // Withdrawal removes reader availability for everyone, collaborators included, on this surface.
    if (rp.p.withdrawnAt !== null) return withdrawnOrNotFound(tx, ctx, id, true);
    if (!(await canReadRevision(tx, ctx, id, rp.r.id))) return withdrawnOrNotFound(tx, ctx, id, false);
  }
  if (!rp) throw new DomainError("not_found", "Briefing not found.");

  const b = (await loadBriefingRow(tx, ctx, id))!;
  const document = parseRevisionDocument(rp.r.documentJson);
  const evidence = await readerEvidence(tx, ctx, rp.r.id);
  const orgSlug = await orgSlugOf(tx, ctx);
  return {
    briefingId: id,
    slug: b.slug,
    title: document.title,
    revision: {
      revisionId: rp.r.id,
      revisionNumber: rp.r.number,
      publicationId: rp.p.id,
      publishedAt: rp.p.publishedAt,
      changeSummary: rp.p.changeSummary,
      isCurrent: b.currentPublicationId === rp.p.id,
      schemaVersion: rp.r.schemaVersion,
      contentHash: rp.r.contentHash,
    },
    document,
    evidence,
    noEvidence: evidence.length === 0,
    capabilities: capList(access),
    canonicalPath: canonicalPath(orgSlug, b.slug),
    pinnedPath: pinnedPath(orgSlug, b.slug, rp.r.number),
  };
}

export function getRevisionDocument(db: Database, ctx: RequestContext, input: GetRevisionDocumentInput): Promise<RevisionDocumentDTO> {
  return inAuthTx(db, ctx, (tx, c) => getRevisionDocumentInTx(tx, c, input));
}

// ---------------------------------------------------------------------------
// compareRevisions
// ---------------------------------------------------------------------------

export const CompareRevisionsInput = z
  .object({
    briefingId: z.string().uuid(),
    from: z.number().int().min(1),
    to: z.union([z.number().int().min(1), z.literal("draft")]),
  })
  .strict();
export type CompareRevisionsInput = z.input<typeof CompareRevisionsInput>;

async function readableRevisionDoc(tx: Tx, ctx: RequestContext, briefingId: string, n: number): Promise<PublishedBriefingDocument> {
  const [r] = await tx
    .select({ id: briefingRevisions.id, json: briefingRevisions.documentJson })
    .from(briefingRevisions)
    .where(
      and(
        eq(briefingRevisions.organizationId, ctx.organizationId),
        eq(briefingRevisions.briefingId, briefingId),
        eq(briefingRevisions.number, n),
      ),
    );
  // Same error as a missing briefing: no existence oracle for inaccessible briefings.
  if (!r || !(await canReadRevision(tx, ctx, briefingId, r.id))) throw new DomainError("not_found", "Briefing not found.");
  return parseRevisionDocument(r.json);
}

/**
 * Diff two readable revisions, or a revision against the draft's published
 * projection (what would be released; requires view_draft).
 */
export async function compareRevisionsInTx(tx: Tx, ctx: RequestContext, rawInput: CompareRevisionsInput): Promise<CompareRevisionsResult> {
  const input = parseInput(CompareRevisionsInput, rawInput);
  const access = await resolveBriefingAccess(tx, ctx, input.briefingId);
  if (!access) throw new DomainError("not_found", "Briefing not found.");
  const from = await readableRevisionDoc(tx, ctx, input.briefingId, input.from);
  if (input.to === "draft") {
    await assertBriefingCapability(tx, ctx, input.briefingId, "view_draft");
    const row = await loadDraftRow(tx, ctx, input.briefingId);
    const projected = toPublishedDocument(parseStoredDraft(row.documentJson)).document;
    return {
      briefingId: input.briefingId,
      from: { revisionNumber: input.from },
      to: { draft: true, lockVersion: row.lockVersion },
      diff: diffDocuments(from, projected),
    };
  }
  const to = await readableRevisionDoc(tx, ctx, input.briefingId, input.to);
  return {
    briefingId: input.briefingId,
    from: { revisionNumber: input.from },
    to: { revisionNumber: input.to },
    diff: diffDocuments(from, to),
  };
}

export function compareRevisions(db: Database, ctx: RequestContext, input: CompareRevisionsInput): Promise<CompareRevisionsResult> {
  return inAuthTx(db, ctx, (tx, c) => compareRevisionsInTx(tx, c, input));
}
