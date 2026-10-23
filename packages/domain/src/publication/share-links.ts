/**
 * Share links (D04): authenticated locators, never authorization. Tokens are
 * high entropy, stored as SHA-256 hashes, returned once, and support expiry
 * and revocation. Stable links resolve to the current publication; pinned
 * links resolve to one revision only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  briefingRevisions,
  briefings,
  organizations,
  publications,
  shareLinks,
  withSystemContext,
  type Database,
  type Tx,
} from "@cerebro/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability, canReadRevision, resolveBriefingAccess } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { mayKnowWithdrawn } from "../briefings/reading";
import { inAuthTx, parseInput, type ServiceOptions } from "../briefings/shared";

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const shareLinkPath = (token: string) => `/s/${token}`;

export const CreateShareLinkInput = z
  .object({
    briefingId: z.string().uuid(),
    pinnedRevisionNumber: z.number().int().min(1).optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();
export type CreateShareLinkInput = z.input<typeof CreateShareLinkInput>;

export interface CreateShareLinkResult {
  shareLinkId: string;
  /** Plaintext token. Returned once; only its hash is stored. */
  token: string;
  path: string;
  pinnedRevisionNumber: number | null;
  expiresAt: Date | null;
}

export interface ShareLinkDTO {
  shareLinkId: string;
  pinnedRevisionNumber: number | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  state: "active" | "expired" | "revoked";
}

export async function createShareLinkInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: CreateShareLinkInput,
  opts: ServiceOptions<CreateShareLinkResult> = {},
): Promise<CreateShareLinkResult> {
  const input = parseInput(CreateShareLinkInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new DomainError("validation", "Expiry must be in the future.", { field: "expiresAt" });
  }
  let revisionId: string | null = null;
  if (input.pinnedRevisionNumber !== undefined) {
    const [r] = await tx
      .select({ id: briefingRevisions.id })
      .from(briefingRevisions)
      .innerJoin(
        publications,
        and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)),
      )
      .where(
        and(
          eq(briefingRevisions.organizationId, ctx.organizationId),
          eq(briefingRevisions.briefingId, input.briefingId),
          eq(briefingRevisions.number, input.pinnedRevisionNumber),
          isNull(publications.withdrawnAt),
        ),
      );
    if (!r) throw new DomainError("validation", "Pinned links need a published, non-withdrawn revision.", { field: "pinnedRevisionNumber" });
    revisionId = r.id;
  }
  const token = randomBytes(32).toString("base64url");
  const [row] = await tx
    .insert(shareLinks)
    .values({
      organizationId: ctx.organizationId,
      briefingId: input.briefingId,
      revisionId,
      tokenHash: hashToken(token),
      createdBy: ctx.userId,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  await recordAudit(tx, ctx, {
    action: "share_link.created",
    targetType: "share_link",
    targetId: row!.id,
    revisionId,
    metadata: { briefingId: input.briefingId, pinned: revisionId !== null, expiresAt: input.expiresAt?.toISOString() ?? null },
  });
  const result: CreateShareLinkResult = {
    shareLinkId: row!.id,
    token,
    path: shareLinkPath(token),
    pinnedRevisionNumber: input.pinnedRevisionNumber ?? null,
    expiresAt: row!.expiresAt,
  };
  if (opts.operation) await opts.operation(tx, result);
  return result;
}

export function createShareLink(
  db: Database,
  ctx: RequestContext,
  input: CreateShareLinkInput,
  opts?: ServiceOptions<CreateShareLinkResult>,
): Promise<CreateShareLinkResult> {
  return inAuthTx(db, ctx, (tx, c) => createShareLinkInTx(tx, c, input, opts));
}

export const RevokeShareLinkInput = z.object({ briefingId: z.string().uuid(), shareLinkId: z.string().uuid() }).strict();
export type RevokeShareLinkInput = z.input<typeof RevokeShareLinkInput>;

/** Revokes the link only; direct grants are untouched. */
export async function revokeShareLinkInTx(tx: Tx, ctx: RequestContext, rawInput: RevokeShareLinkInput): Promise<{ shareLinkId: string; revoked: boolean }> {
  const input = parseInput(RevokeShareLinkInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");
  const rows = await tx
    .update(shareLinks)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(shareLinks.organizationId, ctx.organizationId),
        eq(shareLinks.briefingId, input.briefingId),
        eq(shareLinks.id, input.shareLinkId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .returning({ id: shareLinks.id });
  if (!rows[0]) {
    const [l] = await tx
      .select({ id: shareLinks.id })
      .from(shareLinks)
      .where(and(eq(shareLinks.briefingId, input.briefingId), eq(shareLinks.id, input.shareLinkId)));
    if (!l) throw new DomainError("not_found", "Share link not found.");
    return { shareLinkId: input.shareLinkId, revoked: false };
  }
  await recordAudit(tx, ctx, {
    action: "share_link.revoked",
    targetType: "share_link",
    targetId: input.shareLinkId,
    metadata: { briefingId: input.briefingId },
  });
  return { shareLinkId: input.shareLinkId, revoked: true };
}

export function revokeShareLink(db: Database, ctx: RequestContext, input: RevokeShareLinkInput): Promise<{ shareLinkId: string; revoked: boolean }> {
  return inAuthTx(db, ctx, (tx, c) => revokeShareLinkInTx(tx, c, input));
}

export async function listShareLinksInTx(tx: Tx, ctx: RequestContext, briefingId: string): Promise<ShareLinkDTO[]> {
  const id = parseInput(z.string().uuid(), briefingId);
  await assertBriefingCapability(tx, ctx, id, "manage_access");
  const rows = await tx
    .select({
      l: shareLinks,
      number: briefingRevisions.number,
      expired: sql<boolean>`(${shareLinks.expiresAt} is not null and ${shareLinks.expiresAt} <= now())`,
    })
    .from(shareLinks)
    .leftJoin(
      briefingRevisions,
      and(eq(briefingRevisions.organizationId, shareLinks.organizationId), eq(briefingRevisions.id, shareLinks.revisionId)),
    )
    .where(and(eq(shareLinks.organizationId, ctx.organizationId), eq(shareLinks.briefingId, id)))
    .orderBy(desc(shareLinks.createdAt));
  return rows.map(({ l, number, expired }) => ({
    shareLinkId: l.id,
    pinnedRevisionNumber: number ?? null,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revokedAt: l.revokedAt,
    state: l.revokedAt ? "revoked" : expired ? "expired" : "active",
  }));
}

export function listShareLinks(db: Database, ctx: RequestContext, briefingId: string): Promise<ShareLinkDTO[]> {
  return inAuthTx(db, ctx, (tx, c) => listShareLinksInTx(tx, c, briefingId));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const ResolveShareLinkInput = z
  .object({ token: z.string().min(16).max(200), userId: z.string().uuid().optional() })
  .strict();
export type ResolveShareLinkInput = z.input<typeof ResolveShareLinkInput>;

export interface ResolvedShareLink {
  orgId: string;
  orgSlug: string;
  briefingSlug: string;
  /** Present for pinned links; the reader must open exactly this revision. */
  revisionNumber?: number;
}

const notFound = (reason?: "expired" | "revoked" | "withdrawn"): DomainError =>
  reason
    ? new DomainError("not_found", `This link is no longer available (${reason}).`, { reason })
    : new DomainError("not_found", "Link not found.");

/**
 * Resolve a share token for an authenticated user. Returns a locator only if
 * the user can already read via membership/audience or an explicit grant.
 * Unknown, unauthorized → not_found; expired/revoked/withdrawn → not_found
 * with `details.reason` (never title, excerpts or assets).
 */
export async function resolveShareLink(db: Database, rawInput: ResolveShareLinkInput): Promise<ResolvedShareLink> {
  const input = parseInput(ResolveShareLinkInput, rawInput);
  if (!input.userId) throw new DomainError("unauthenticated", "Sign in to open this link.");
  const userId = input.userId;

  // System context, justified: the token is the only input and it does not
  // say which company it belongs to, so the tenant cannot be set before the
  // lookup. This reads only the link's routing columns (org, briefing,
  // revision, expiry/revocation) by token hash; no content. All authorization
  // happens below under withAuthContext for that company.
  const link = await withSystemContext(db, async (tx) => {
    const [l] = await tx
      .select({
        organizationId: shareLinks.organizationId,
        briefingId: shareLinks.briefingId,
        revisionId: shareLinks.revisionId,
        revokedAt: shareLinks.revokedAt,
        expired: sql<boolean>`(${shareLinks.expiresAt} is not null and ${shareLinks.expiresAt} <= now())`,
      })
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashToken(input.token)));
    return l ?? null;
  });
  if (!link) throw notFound();

  const ctx: RequestContext = { userId, organizationId: link.organizationId, via: "web", requestId: randomUUID() };
  return inAuthTx(db, ctx, async (tx, c) => {
    const access = await resolveBriefingAccess(tx, c, link.briefingId);
    // Users with no relationship to the briefing learn nothing, not even that the link expired.
    const related = !!access && (access.capabilities.has("read") || (await mayKnowWithdrawn(tx, c, link.briefingId)));
    if (!access || !related) throw notFound();
    if (link.revokedAt) throw notFound("revoked");
    if (link.expired) throw notFound("expired");

    const [meta] = await tx
      .select({ slug: briefings.slug, orgSlug: organizations.slug })
      .from(briefings)
      .innerJoin(organizations, eq(organizations.id, briefings.organizationId))
      .where(and(eq(briefings.organizationId, c.organizationId), eq(briefings.id, link.briefingId)));
    if (!meta) throw notFound();
    const base = { orgId: c.organizationId, orgSlug: meta.orgSlug, briefingSlug: meta.slug };

    if (link.revisionId) {
      const [r] = await tx
        .select({ number: briefingRevisions.number, withdrawnAt: publications.withdrawnAt })
        .from(briefingRevisions)
        .innerJoin(
          publications,
          and(eq(publications.organizationId, briefingRevisions.organizationId), eq(publications.revisionId, briefingRevisions.id)),
        )
        .where(and(eq(briefingRevisions.organizationId, c.organizationId), eq(briefingRevisions.id, link.revisionId)));
      if (!r) throw notFound();
      if (r.withdrawnAt !== null) throw notFound("withdrawn");
      if (!(await canReadRevision(tx, c, link.briefingId, link.revisionId))) throw notFound();
      return { ...base, revisionNumber: r.number };
    }
    if (!access.currentRevisionId) throw notFound("withdrawn");
    if (!access.capabilities.has("read")) throw notFound();
    return base;
  });
}
