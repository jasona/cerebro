/**
 * Invitations to company membership or to a briefing grant. Tokens are high
 * entropy, returned once, stored only as SHA-256 hashes and expire. Accepting
 * binds to the email on the authenticated user's profile.
 */
import { withAuthContext, withSystemContext, type Database, type Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability, getMembership, resolveBriefingAccess, type CompanyRole } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { normalizeEmail, parseInput, randomBase62, requireAdmin, requireMember, sha256Hex, toDate, toDateOrNull, Uuid, withCtx } from "./shared";

export type InvitationKind = "membership" | "briefing";
export type InvitationGrantRole = "reader" | "editor" | "publisher";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationDTO {
  id: string;
  email: string;
  kind: InvitationKind;
  /** Membership invitations: the company role granted on acceptance. */
  role: "admin" | "member" | null;
  briefingId: string | null;
  grantRole: InvitationGrantRole | null;
  /** Revision-scoped reader invitation. */
  revisionId: string | null;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  status: InvitationStatus;
}

export const INVITATION_TOKEN_PREFIX = "cbi_";
const DEFAULT_TTL_DAYS = 14;

interface InvitationRow extends Record<string, unknown> {
  id: string;
  email: string;
  kind: "membership" | "briefing_grant";
  membership_role: "admin" | "member" | null;
  briefing_id: string | null;
  grant_role: InvitationGrantRole | null;
  revision_id: string | null;
  invited_by: string;
  expires_at: unknown;
  accepted_at: unknown;
  revoked_at: unknown;
  created_at: unknown;
}

const COLS = sql`id, email, kind, membership_role, briefing_id, grant_role, revision_id, invited_by,
  expires_at, accepted_at, revoked_at, created_at`;

function toInvitation(r: InvitationRow, now = new Date()): InvitationDTO {
  const expiresAt = toDate(r.expires_at);
  const acceptedAt = toDateOrNull(r.accepted_at);
  const revokedAt = toDateOrNull(r.revoked_at);
  const status: InvitationStatus = acceptedAt ? "accepted" : revokedAt ? "revoked" : expiresAt <= now ? "expired" : "pending";
  return {
    id: r.id,
    email: r.email,
    kind: r.kind === "membership" ? "membership" : "briefing",
    role: r.membership_role,
    briefingId: r.briefing_id,
    grantRole: r.grant_role,
    revisionId: r.revision_id,
    invitedBy: r.invited_by,
    expiresAt,
    acceptedAt,
    revokedAt,
    createdAt: toDate(r.created_at),
    status,
  };
}

const CreateInvitationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("membership"),
    email: z.string().trim().email().max(320),
    role: z.enum(["admin", "member"]).default("member"),
    expiresInDays: z.number().int().min(1).max(90).default(DEFAULT_TTL_DAYS),
  }),
  z.object({
    kind: z.literal("briefing"),
    email: z.string().trim().email().max(320),
    briefingId: Uuid,
    grantRole: z.enum(["reader", "editor", "publisher"]).default("reader"),
    revisionId: Uuid.optional(),
    expiresInDays: z.number().int().min(1).max(90).default(DEFAULT_TTL_DAYS),
  }),
]);

export type CreateInvitationInput =
  | { kind: "membership"; email: string; role?: "admin" | "member"; expiresInDays?: number }
  | {
      kind: "briefing";
      email: string;
      briefingId: string;
      grantRole?: InvitationGrantRole;
      revisionId?: string;
      expiresInDays?: number;
    };

/**
 * Membership invitations: company owner/admin (admin role invitations: owner).
 * Briefing invitations: `manage_access` on the briefing.
 */
export async function createInvitationInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: CreateInvitationInput,
): Promise<{ invitation: InvitationDTO; token: string }> {
  const input = parseInput(CreateInvitationSchema, rawInput);
  const email = normalizeEmail(input.email);
  const token = `${INVITATION_TOKEN_PREFIX}${randomBase62(32)}`;
  const tokenHash = sha256Hex(token);
  const org = ctx.organizationId;

  let row: InvitationRow | undefined;
  if (input.kind === "membership") {
    const actor = await requireAdmin(tx, ctx);
    if (input.role === "admin" && actor.role !== "owner") {
      throw new DomainError("forbidden", "Only a company owner can invite an admin.");
    }
    const existing = await tx.execute(sql`
      select 1 from memberships m join users u on u.id = m.user_id
      where m.organization_id = ${org}::uuid and lower(u.email) = ${email} and m.status = 'active'`);
    if (existing.rows.length) throw new DomainError("conflict", "This person is already a member.");
    row = (
      await tx.execute<InvitationRow>(sql`
        insert into invitations (organization_id, email, kind, membership_role, token_hash, invited_by, expires_at)
        values (${org}::uuid, ${email}, 'membership', ${input.role}, ${tokenHash}, ${ctx.userId}::uuid,
                now() + make_interval(days => ${input.expiresInDays}::int))
        returning ${COLS}`)
    ).rows[0];
  } else {
    await requireMember(tx, ctx);
    await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");
    if (input.revisionId && input.grantRole !== "reader") {
      throw new DomainError("validation", "Only reader invitations can be scoped to a revision.");
    }
    if (input.revisionId) {
      const rev = await tx.execute(sql`
        select 1 from briefing_revisions
        where organization_id = ${org}::uuid and briefing_id = ${input.briefingId}::uuid and id = ${input.revisionId}::uuid`);
      if (!rev.rows.length) throw new DomainError("not_found", "Revision not found.");
    }
    row = (
      await tx.execute<InvitationRow>(sql`
        insert into invitations (organization_id, email, kind, briefing_id, grant_role, revision_id, token_hash, invited_by, expires_at)
        values (${org}::uuid, ${email}, 'briefing_grant', ${input.briefingId}::uuid, ${input.grantRole},
                ${input.revisionId ?? null}::uuid, ${tokenHash}, ${ctx.userId}::uuid,
                now() + make_interval(days => ${input.expiresInDays}::int))
        returning ${COLS}`)
    ).rows[0];
  }
  const invitation = toInvitation(row!);
  await recordAudit(tx, ctx, {
    action: "invitation.created",
    targetType: "invitation",
    targetId: invitation.id,
    metadata: {
      kind: invitation.kind,
      role: invitation.role,
      briefingId: invitation.briefingId,
      grantRole: invitation.grantRole,
      revisionId: invitation.revisionId,
    },
  });
  return { invitation, token };
}

/** Create an invitation; the plaintext `token` is returned once and never stored. */
export const createInvitation = (db: Database, ctx: RequestContext, input: CreateInvitationInput) =>
  withCtx(db, ctx, (tx, c) => createInvitationInTx(tx, c, input));

const ListInvitationsInput = z
  .object({ briefingId: Uuid.optional(), includeClosed: z.boolean().default(false) })
  .default({ includeClosed: false });

/** Membership invitations (owner/admin) or, with `briefingId`, that briefing's invitations (`manage_access`). */
export async function listInvitationsInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { briefingId?: string; includeClosed?: boolean } = {},
): Promise<InvitationDTO[]> {
  const { briefingId, includeClosed } = parseInput(ListInvitationsInput, input);
  if (briefingId) {
    await requireMember(tx, ctx);
    await assertBriefingCapability(tx, ctx, briefingId, "manage_access");
  } else {
    await requireAdmin(tx, ctx);
  }
  const res = await tx.execute<InvitationRow>(sql`
    select ${COLS} from invitations
    where organization_id = ${ctx.organizationId}::uuid
      and ${briefingId ? sql`kind = 'briefing_grant' and briefing_id = ${briefingId}::uuid` : sql`kind = 'membership'`}
      and ${includeClosed ? sql`true` : sql`accepted_at is null and revoked_at is null and expires_at > now()`}
    order by created_at desc, id`);
  return res.rows.map((r) => toInvitation(r));
}

export const listInvitations = (db: Database, ctx: RequestContext, input: { briefingId?: string; includeClosed?: boolean } = {}) =>
  withCtx(db, ctx, (tx, c) => listInvitationsInTx(tx, c, input));

const RevokeInvitationInput = z.object({ invitationId: Uuid });

export async function revokeInvitationInTx(tx: Tx, ctx: RequestContext, input: { invitationId: string }): Promise<InvitationDTO> {
  const { invitationId } = parseInput(RevokeInvitationInput, input);
  await requireMember(tx, ctx);
  const current = (
    await tx.execute<InvitationRow>(sql`
      select ${COLS} from invitations where organization_id = ${ctx.organizationId}::uuid and id = ${invitationId}::uuid`)
  ).rows[0];
  if (!current) throw new DomainError("not_found", "Invitation not found.");
  if (current.kind === "membership") await requireAdmin(tx, ctx);
  else await assertBriefingCapability(tx, ctx, current.briefing_id!, "manage_access");
  if (current.accepted_at) throw new DomainError("conflict", "Invitation was already accepted.", { reason: "already_accepted" });
  if (current.revoked_at) return toInvitation(current);
  const row = (
    await tx.execute<InvitationRow>(sql`
      update invitations set revoked_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${invitationId}::uuid
      returning ${COLS}`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "invitation.revoked", targetType: "invitation", targetId: invitationId });
  return toInvitation(row);
}

export const revokeInvitation = (db: Database, ctx: RequestContext, input: { invitationId: string }) =>
  withCtx(db, ctx, (tx, c) => revokeInvitationInTx(tx, c, input));

const AcceptInvitationInput = z.object({
  token: z.string().min(10).max(200),
  userId: Uuid,
});

export interface AcceptedInvitation {
  invitationId: string;
  kind: InvitationKind;
  organizationId: string;
  organizationSlug: string;
  /** Company role for membership invitations. */
  role: CompanyRole | null;
  briefingId: string | null;
  briefingSlug: string | null;
  grantRole: InvitationGrantRole | null;
}

/**
 * Accept an invitation as the authenticated `userId`. The invitation's email
 * must equal the user's profile email. Creates or reactivates the membership,
 * or creates the briefing grant. Audited.
 */
export async function acceptInvitation(db: Database, input: { token: string; userId: string }): Promise<AcceptedInvitation> {
  const { token, userId } = parseInput(AcceptInvitationInput, input);
  if (!token.startsWith(INVITATION_TOKEN_PREFIX)) throw new DomainError("not_found", "Invitation not found.");
  const tokenHash = sha256Hex(token);
  // System context: narrow credential lookup. The token hash is the bearer
  // credential and determines which company the invitation belongs to; only
  // the invitation and organization ids are read here.
  const located = await withSystemContext(db, async (tx) => {
    const res = await tx.execute<{ id: string; organization_id: string }>(
      sql`select id, organization_id from invitations where token_hash = ${tokenHash}`,
    );
    return res.rows[0] ?? null;
  });
  if (!located) throw new DomainError("not_found", "Invitation not found.");
  const organizationId = located.organization_id;

  return withAuthContext(db, { userId, organizationId }, async (tx) => {
    const ctx: RequestContext = { userId, organizationId, via: "web", requestId: `accept-${located.id}` };
    const inv = (
      await tx.execute<InvitationRow>(sql`
        select ${COLS} from invitations where organization_id = ${organizationId}::uuid and id = ${located.id}::uuid
        for update`)
    ).rows[0];
    if (!inv) throw new DomainError("not_found", "Invitation not found.");
    if (inv.revoked_at) throw new DomainError("conflict", "This invitation was revoked.", { reason: "revoked" });
    if (inv.accepted_at) throw new DomainError("conflict", "This invitation was already used.", { reason: "already_accepted" });
    if (toDate(inv.expires_at) <= new Date()) throw new DomainError("conflict", "This invitation has expired.", { reason: "expired" });

    const user = (await tx.execute<{ email: string }>(sql`select email from users where id = ${userId}::uuid`)).rows[0];
    if (!user) throw new DomainError("unauthenticated", "Unknown user.");
    if (normalizeEmail(user.email) !== normalizeEmail(inv.email)) {
      throw new DomainError("forbidden", "This invitation was sent to a different email address.", { reason: "email_mismatch" });
    }

    // The invitation carries the inviter's authority: recheck it now rather
    // than trusting what was true when the invitation was issued.
    const inviterCtx: RequestContext = { ...ctx, userId: inv.invited_by };
    const inviterAuthorized =
      inv.kind === "membership"
        ? await (async () => {
            const m = await getMembership(tx, inviterCtx);
            if (!m) return false;
            return inv.membership_role === "admin" ? m.role === "owner" : m.role === "owner" || m.role === "admin";
          })()
        : !!(await resolveBriefingAccess(tx, inviterCtx, inv.briefing_id!))?.capabilities.has("manage_access");
    if (!inviterAuthorized) {
      throw new DomainError("forbidden", "This invitation is no longer valid.", { reason: "inviter_not_authorized" });
    }

    const org = (await tx.execute<{ slug: string }>(sql`select slug from organizations where id = ${organizationId}::uuid`)).rows[0];
    let role: CompanyRole | null = null;
    let briefingSlug: string | null = null;

    if (inv.kind === "membership") {
      const existing = (
        await tx.execute<{ status: string; role: CompanyRole }>(sql`
          select status, role from memberships where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid`)
      ).rows[0];
      if (existing?.status === "active") {
        role = existing.role;
      } else {
        role = inv.membership_role ?? "member";
        await tx.execute(sql`
          insert into memberships (organization_id, user_id, role, status)
          values (${organizationId}::uuid, ${userId}::uuid, ${role}, 'active')
          on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active', updated_at = now()`);
      }
    } else {
      const grantRole = inv.grant_role!;
      if (grantRole !== "reader" && !(await getMembership(tx, ctx))) {
        throw new DomainError("forbidden", "Editor and publisher roles require company membership.", { reason: "membership_required" });
      }
      const b = (
        await tx.execute<{ slug: string; archived_at: unknown }>(sql`
          select slug, archived_at from briefings where organization_id = ${organizationId}::uuid and id = ${inv.briefing_id}::uuid`)
      ).rows[0];
      if (!b || b.archived_at) throw new DomainError("not_found", "Briefing not found.");
      briefingSlug = b.slug;
      await tx.execute(sql`
        insert into briefing_grants (organization_id, briefing_id, user_id, role, revision_id, issued_by)
        values (${organizationId}::uuid, ${inv.briefing_id}::uuid, ${userId}::uuid, ${grantRole},
                ${inv.revision_id}::uuid, ${inv.invited_by}::uuid)
        on conflict do nothing`);
    }

    await tx.execute(sql`
      update invitations set accepted_at = now(), accepted_by = ${userId}::uuid
      where organization_id = ${organizationId}::uuid and id = ${inv.id}::uuid`);
    await recordAudit(tx, ctx, {
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: inv.id,
      metadata: {
        kind: inv.kind === "membership" ? "membership" : "briefing",
        role,
        briefingId: inv.briefing_id,
        grantRole: inv.grant_role,
        revisionId: inv.revision_id,
      },
    });
    if (inv.kind === "briefing_grant") {
      await recordAudit(tx, ctx, {
        action: "grant.created",
        targetType: "briefing",
        targetId: inv.briefing_id,
        revisionId: inv.revision_id,
        metadata: { userId, role: inv.grant_role, viaInvitation: inv.id },
      });
    } else {
      await recordAudit(tx, ctx, { action: "membership.added", targetType: "membership", targetId: userId, metadata: { role } });
    }

    return {
      invitationId: inv.id,
      kind: inv.kind === "membership" ? "membership" : "briefing",
      organizationId,
      organizationSlug: org?.slug ?? "",
      role,
      briefingId: inv.briefing_id,
      briefingSlug,
      grantRole: inv.grant_role,
    };
  });
}
