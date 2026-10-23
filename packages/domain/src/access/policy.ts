/**
 * Briefing access policy (ACCESS_MATRIX.md). Every function expects `tx` to be
 * a transaction opened with withAuthContext for `ctx`; RLS provides tenant
 * isolation underneath, these rules provide content authorization.
 *
 * The same SQL predicates back both per-briefing capability checks and the
 * library condition, so lists and the reader cannot disagree.
 */
import { briefings, type Executor } from "@cerebro/database";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { RequestContext } from "../context";
import { DomainError } from "../errors";

export const CAPABILITIES = [
  "read",
  "view_evidence",
  "view_draft",
  "edit",
  "publish",
  "manage_access",
  "withdraw",
  "view_engagement",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type CompanyRole = "owner" | "admin" | "member";

export interface Membership {
  membershipId: string;
  organizationId: string;
  userId: string;
  role: CompanyRole;
}

const Uuid = z.string().uuid();
const parseCtx = (ctx: RequestContext): RequestContext => RequestContext.parse(ctx);

// ---------------------------------------------------------------------------
// SQL predicates over the outer `briefings` row (unaliased table reference)
// ---------------------------------------------------------------------------

const activeMember = (userId: string): SQL => sql`exists (
  select 1 from memberships m
  where m.organization_id = ${briefings.organizationId}
    and m.user_id = ${userId}::uuid
    and m.status = 'active')`;

/** Audience membership, excluding the company-membership requirement. */
const inAudience = (userId: string): SQL => sql`(
  ${briefings.visibility} = 'company'
  or (${briefings.visibility} = 'department' and (
    exists (
      select 1 from department_memberships dm
      where dm.organization_id = ${briefings.organizationId}
        and dm.department_id = ${briefings.audienceDepartmentId}
        and dm.user_id = ${userId}::uuid
        and dm.status = 'active')
    or exists (
      select 1 from team_memberships tm
      join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
      where tm.organization_id = ${briefings.organizationId}
        and t.department_id = ${briefings.audienceDepartmentId}
        and tm.user_id = ${userId}::uuid
        and tm.status = 'active')))
  or (${briefings.visibility} = 'team' and exists (
    select 1 from team_memberships tm
    where tm.organization_id = ${briefings.organizationId}
      and tm.team_id = ${briefings.audienceTeamId}
      and tm.user_id = ${userId}::uuid
      and tm.status = 'active')))`;

const activeGrantRoles = (userId: string, roles: readonly string[]): SQL => sql`exists (
  select 1 from briefing_grants g
  where g.organization_id = ${briefings.organizationId}
    and g.briefing_id = ${briefings.id}
    and g.user_id = ${userId}::uuid
    and g.revoked_at is null
    and g.role in (${sql.join(
      roles.map((r) => sql`${r}`),
      sql`, `,
    )}))`;

/** Owner, editor or publisher: requires active company membership. */
const collaborator = (userId: string): SQL =>
  sql`(${activeMember(userId)} and (${briefings.ownerId} = ${userId}::uuid or ${activeGrantRoles(userId, ["owner", "editor", "publisher"])}))`;

/** Reader grant covering the given revision (unscoped, or scoped to exactly that revision). */
const readerGrantFor = (userId: string, revisionId: SQL): SQL => sql`exists (
  select 1 from briefing_grants g
  where g.organization_id = ${briefings.organizationId}
    and g.briefing_id = ${briefings.id}
    and g.user_id = ${userId}::uuid
    and g.revoked_at is null
    and g.role = 'reader'
    and (g.revision_id is null or g.revision_id = ${revisionId}))`;

const currentPublicationRevision: SQL = sql`(
  select p.revision_id from publications p
  where p.organization_id = ${briefings.organizationId}
    and p.id = ${briefings.currentPublicationId}
    and p.withdrawn_at is null)`;

/**
 * Drizzle condition selecting briefings in the context company that have a
 * current, non-withdrawn publication readable by the user. Use with the
 * unaliased `briefings` table, e.g.
 * `db.select().from(briefings).where(and(readablePublishedBriefingsCondition(ctx), ...))`.
 *
 * Archived briefings are not excluded here; library views filter them.
 */
export function readablePublishedBriefingsCondition(ctx: RequestContext): SQL {
  const { userId, organizationId } = parseCtx(ctx);
  return sql`(${briefings.organizationId} = ${organizationId}::uuid
    and ${currentPublicationRevision} is not null
    and (
      ${collaborator(userId)}
      or (${activeMember(userId)} and ${inAudience(userId)})
      or ${readerGrantFor(userId, currentPublicationRevision)}
    ))`;
}

// ---------------------------------------------------------------------------
// Company membership
// ---------------------------------------------------------------------------

/** The user's active company membership in the context company, or null. */
export async function getMembership(tx: Executor, ctx: RequestContext): Promise<Membership | null> {
  const { userId, organizationId } = parseCtx(ctx);
  const res = await tx.execute<{ id: string; role: CompanyRole }>(sql`
    select id, role from memberships
    where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid and status = 'active'`);
  const row = res.rows[0];
  return row ? { membershipId: row.id, organizationId, userId, role: row.role } : null;
}

/** Require an active company membership with one of `roles`; throws `forbidden` otherwise. */
export async function requireCompanyRole(
  tx: Executor,
  ctx: RequestContext,
  roles: readonly CompanyRole[],
): Promise<Membership> {
  const membership = await getMembership(tx, ctx);
  if (!membership || !roles.includes(membership.role)) {
    throw new DomainError("forbidden", "This action requires a different company role.");
  }
  return membership;
}

// ---------------------------------------------------------------------------
// Briefing capabilities
// ---------------------------------------------------------------------------

export type BriefingRole = "owner" | "editor" | "publisher";

export interface BriefingAccess {
  briefingId: string;
  capabilities: Set<Capability>;
  /** Briefing roles held (owner, editor, publisher); empty for readers. */
  roles: BriefingRole[];
  isCompanyMember: boolean;
  /** Revision of the current, non-withdrawn publication. */
  currentRevisionId: string | null;
}

const ROLE_CAPABILITIES: Record<BriefingRole, readonly Capability[]> = {
  owner: CAPABILITIES,
  editor: ["read", "view_evidence", "view_draft", "edit", "view_engagement"],
  publisher: ["read", "view_evidence", "view_draft", "publish", "withdraw", "view_engagement"],
};

interface AccessRow extends Record<string, unknown> {
  is_member: boolean;
  is_owner: boolean;
  grant_roles: string[];
  in_audience: boolean;
  reader_grant_current: boolean;
  current_revision_id: string | null;
}

/**
 * Full access resolution for one briefing, or null when the briefing does not
 * exist in the context company.
 */
export async function resolveBriefingAccess(
  tx: Executor,
  ctx: RequestContext,
  briefingId: string,
): Promise<BriefingAccess | null> {
  const { userId, organizationId } = parseCtx(ctx);
  if (!Uuid.safeParse(briefingId).success) return null;
  const res = await tx.execute<AccessRow>(sql`
    select
      ${activeMember(userId)} as is_member,
      (${briefings.ownerId} = ${userId}::uuid) as is_owner,
      array(
        select g.role from briefing_grants g
        where g.organization_id = ${briefings.organizationId}
          and g.briefing_id = ${briefings.id}
          and g.user_id = ${userId}::uuid
          and g.revoked_at is null
          and g.role <> 'reader'
      )::text[] as grant_roles,
      ${inAudience(userId)} as in_audience,
      ${readerGrantFor(userId, currentPublicationRevision)} as reader_grant_current,
      ${currentPublicationRevision}::text as current_revision_id
    from ${briefings}
    where ${briefings.id} = ${briefingId}::uuid and ${briefings.organizationId} = ${organizationId}::uuid`);
  const row = res.rows[0];
  if (!row) return null;

  const member = row.is_member;
  // Owner, editor and publisher roles require active company membership.
  const granted = member ? row.grant_roles : [];
  const roles: BriefingRole[] = [];
  if (member && (row.is_owner || granted.includes("owner"))) roles.push("owner");
  if (granted.includes("editor")) roles.push("editor");
  if (granted.includes("publisher")) roles.push("publisher");

  const capabilities = new Set<Capability>();
  for (const r of roles) for (const c of ROLE_CAPABILITIES[r]) capabilities.add(c);
  // Membership-derived and reader-grant reading apply only to released content.
  if (row.current_revision_id !== null && ((member && row.in_audience) || row.reader_grant_current)) {
    capabilities.add("read");
    capabilities.add("view_evidence");
  }

  return { briefingId, capabilities, roles, isCompanyMember: member, currentRevisionId: row.current_revision_id };
}

/** The user's capabilities on a briefing; empty when it is missing or unreadable. */
export async function getBriefingCapabilities(
  tx: Executor,
  ctx: RequestContext,
  briefingId: string,
): Promise<Set<Capability>> {
  return (await resolveBriefingAccess(tx, ctx, briefingId))?.capabilities ?? new Set();
}

/**
 * Throw unless the user holds `capability`. Users who cannot read the
 * briefing at all get `not_found` (no disclosure); readers lacking the
 * capability get `forbidden`.
 */
export async function assertBriefingCapability(
  tx: Executor,
  ctx: RequestContext,
  briefingId: string,
  capability: Capability,
): Promise<Set<Capability>> {
  const caps = await getBriefingCapabilities(tx, ctx, briefingId);
  if (!caps.has("read")) throw new DomainError("not_found", "Briefing not found.");
  if (!caps.has(capability)) throw new DomainError("forbidden", "You do not have permission for this action.");
  return caps;
}

/**
 * Whether the user may read a specific published revision (pinned links,
 * history, revision-scoped grants). Collaborators can read every revision;
 * everyone else needs a non-withdrawn publication of that revision plus
 * audience membership, an unscoped reader grant, or a grant scoped to it.
 */
export async function canReadRevision(
  tx: Executor,
  ctx: RequestContext,
  briefingId: string,
  revisionId: string,
): Promise<boolean> {
  const { userId, organizationId } = parseCtx(ctx);
  if (!Uuid.safeParse(briefingId).success || !Uuid.safeParse(revisionId).success) return false;
  const res = await tx.execute<{ ok: boolean }>(sql`
    select (
      ${collaborator(userId)}
      or (
        exists (
          select 1 from publications p
          where p.organization_id = r.organization_id and p.revision_id = r.id and p.withdrawn_at is null)
        and (
          (${activeMember(userId)} and ${inAudience(userId)})
          or ${readerGrantFor(userId, sql`r.id`)}
        )
      )
    ) as ok
    from briefing_revisions r
    join ${briefings} on ${briefings.organizationId} = r.organization_id and ${briefings.id} = r.briefing_id
    where r.id = ${revisionId}::uuid
      and r.briefing_id = ${briefingId}::uuid
      and r.organization_id = ${organizationId}::uuid`);
  return res.rows[0]?.ok === true;
}
