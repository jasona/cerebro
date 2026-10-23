/**
 * Company memberships, department/team membership, roles and the people
 * directory. Administration requires company owner or admin; assigning or
 * removing owner/admin roles requires owner (ACCESS_MATRIX). All changes are
 * audited.
 *
 * Removing a company membership sets its status to `removed`. Department and
 * team rows are left as they were: every access check requires active company
 * membership, so all derived access ends immediately by design.
 */
import type { Database, Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { CompanyRole } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { findDepartment, findTeam } from "./structure";
import { likePattern, parseInput, requireAdmin, requireMember, Uuid, withCtx } from "./shared";

export type CompanyMembershipStatus = "active" | "invited" | "suspended" | "removed";

export interface MemberTeamRef {
  teamId: string;
  name: string;
  slug: string;
  departmentId: string;
  departmentName: string;
}

export interface MemberDepartmentRef {
  departmentId: string;
  name: string;
  slug: string;
}

export interface MemberDTO {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  role: CompanyRole;
  status: CompanyMembershipStatus;
  /** Active team memberships in non-archived teams. */
  teams: MemberTeamRef[];
  /** Active explicit department memberships in non-archived departments. */
  departments: MemberDepartmentRef[];
}

/** Directory entry: active members only, no email or status. */
export interface PersonDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: CompanyRole;
  teams: MemberTeamRef[];
  departments: MemberDepartmentRef[];
}

interface MemberRow extends Record<string, unknown> {
  membership_id: string;
  user_id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  role: CompanyRole;
  status: CompanyMembershipStatus;
}

async function loadAffiliations(tx: Tx, ctx: RequestContext, userIds: string[]) {
  const teams = new Map<string, MemberTeamRef[]>();
  const depts = new Map<string, MemberDepartmentRef[]>();
  if (userIds.length === 0) return { teams, depts };
  const ids = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const t = await tx.execute<{ user_id: string; team_id: string; name: string; slug: string; department_id: string; department_name: string }>(sql`
    select tm.user_id, t.id as team_id, t.name, t.slug, d.id as department_id, d.name as department_name
    from team_memberships tm
    join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
    join departments d on d.organization_id = t.organization_id and d.id = t.department_id
    where tm.organization_id = ${ctx.organizationId}::uuid and tm.status = 'active'
      and t.archived_at is null and tm.user_id in (${ids})
    order by lower(d.name), lower(t.name)`);
  for (const r of t.rows) {
    const list = teams.get(r.user_id) ?? [];
    list.push({ teamId: r.team_id, name: r.name, slug: r.slug, departmentId: r.department_id, departmentName: r.department_name });
    teams.set(r.user_id, list);
  }
  const d = await tx.execute<{ user_id: string; department_id: string; name: string; slug: string }>(sql`
    select dm.user_id, d.id as department_id, d.name, d.slug
    from department_memberships dm
    join departments d on d.organization_id = dm.organization_id and d.id = dm.department_id
    where dm.organization_id = ${ctx.organizationId}::uuid and dm.status = 'active'
      and d.archived_at is null and dm.user_id in (${ids})
    order by lower(d.name)`);
  for (const r of d.rows) {
    const list = depts.get(r.user_id) ?? [];
    list.push({ departmentId: r.department_id, name: r.name, slug: r.slug });
    depts.set(r.user_id, list);
  }
  return { teams, depts };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const ListMembersInput = z
  .object({ includeRemoved: z.boolean().default(false), teamId: Uuid.optional(), departmentId: Uuid.optional() })
  .default({ includeRemoved: false });

export async function listMembersInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { includeRemoved?: boolean; teamId?: string; departmentId?: string } = {},
): Promise<MemberDTO[]> {
  const { includeRemoved, teamId, departmentId } = parseInput(ListMembersInput, input);
  await requireAdmin(tx, ctx);
  const res = await tx.execute<MemberRow>(sql`
    select m.id as membership_id, m.user_id, u.display_name, u.email, u.avatar_url, m.role, m.status
    from memberships m
    join users u on u.id = m.user_id
    where m.organization_id = ${ctx.organizationId}::uuid
      and ${includeRemoved ? sql`true` : sql`m.status = 'active'`}
      and ${
        teamId
          ? sql`exists (select 1 from team_memberships tm where tm.organization_id = m.organization_id
                  and tm.user_id = m.user_id and tm.team_id = ${teamId}::uuid and tm.status = 'active')`
          : sql`true`
      }
      and ${
        departmentId
          ? sql`exists (select 1 from department_memberships dm where dm.organization_id = m.organization_id
                  and dm.user_id = m.user_id and dm.department_id = ${departmentId}::uuid and dm.status = 'active')`
          : sql`true`
      }
    order by lower(u.display_name), m.user_id`);
  const { teams, depts } = await loadAffiliations(
    tx,
    ctx,
    res.rows.map((r) => r.user_id),
  );
  return res.rows.map((r) => ({
    membershipId: r.membership_id,
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    avatarUrl: r.avatar_url,
    role: r.role,
    status: r.status,
    teams: teams.get(r.user_id) ?? [],
    departments: depts.get(r.user_id) ?? [],
  }));
}

/** Admin member list with teams and departments. Owner/admin only. */
export const listMembers = (
  db: Database,
  ctx: RequestContext,
  input: { includeRemoved?: boolean; teamId?: string; departmentId?: string } = {},
) => withCtx(db, ctx, (tx, c) => listMembersInTx(tx, c, input));

const PeopleInput = z.object({ q: z.string().trim().max(200).optional(), teamId: Uuid.optional() }).default({});

export async function getPeopleInTx(tx: Tx, ctx: RequestContext, input: { q?: string; teamId?: string } = {}): Promise<PersonDTO[]> {
  const { q, teamId } = parseInput(PeopleInput, input);
  // External readers can see some user and membership rows at the RLS level;
  // the directory is for active members only.
  await requireMember(tx, ctx);
  const res = await tx.execute<MemberRow>(sql`
    select m.id as membership_id, m.user_id, u.display_name, u.email, u.avatar_url, m.role, m.status
    from memberships m
    join users u on u.id = m.user_id
    where m.organization_id = ${ctx.organizationId}::uuid and m.status = 'active'
      and ${q ? sql`u.display_name ilike ${likePattern(q)} escape '\\'` : sql`true`}
      and ${
        teamId
          ? sql`exists (select 1 from team_memberships tm where tm.organization_id = m.organization_id
                  and tm.user_id = m.user_id and tm.team_id = ${teamId}::uuid and tm.status = 'active')`
          : sql`true`
      }
    order by lower(u.display_name), m.user_id`);
  const { teams, depts } = await loadAffiliations(
    tx,
    ctx,
    res.rows.map((r) => r.user_id),
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    role: r.role,
    teams: teams.get(r.user_id) ?? [],
    departments: depts.get(r.user_id) ?? [],
  }));
}

/** Company directory (active members). Members only. */
export const getPeople = (db: Database, ctx: RequestContext, input: { q?: string; teamId?: string } = {}) =>
  withCtx(db, ctx, (tx, c) => getPeopleInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Team and department membership
// ---------------------------------------------------------------------------

async function requireActiveTarget(tx: Tx, ctx: RequestContext, userId: string): Promise<{ role: CompanyRole }> {
  const res = await tx.execute<{ role: CompanyRole }>(sql`
    select role from memberships
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${userId}::uuid and status = 'active'`);
  const row = res.rows[0];
  if (!row) throw new DomainError("not_found", "Member not found.");
  return row;
}

const TeamMemberInput = z.object({ teamId: Uuid, userId: Uuid });

export async function addTeamMemberInTx(tx: Tx, ctx: RequestContext, input: { teamId: string; userId: string }): Promise<void> {
  const { teamId, userId } = parseInput(TeamMemberInput, input);
  await requireAdmin(tx, ctx);
  const team = await findTeam(tx, ctx, teamId);
  if (!team) throw new DomainError("not_found", "Team not found.");
  if (team.archivedAt) throw new DomainError("conflict", "Team is archived.");
  await requireActiveTarget(tx, ctx, userId);
  const res = await tx.execute<{ id: string }>(sql`
    insert into team_memberships (organization_id, team_id, user_id, status)
    values (${ctx.organizationId}::uuid, ${teamId}::uuid, ${userId}::uuid, 'active')
    on conflict (team_id, user_id) do update set status = 'active', updated_at = now()
      where team_memberships.status <> 'active'
    returning id`);
  if (res.rows[0]) {
    await recordAudit(tx, ctx, { action: "team_membership.added", targetType: "team", targetId: teamId, metadata: { userId } });
  }
}

export const addTeamMember = (db: Database, ctx: RequestContext, input: { teamId: string; userId: string }) =>
  withCtx(db, ctx, (tx, c) => addTeamMemberInTx(tx, c, input));

export async function removeTeamMemberInTx(tx: Tx, ctx: RequestContext, input: { teamId: string; userId: string }): Promise<void> {
  const { teamId, userId } = parseInput(TeamMemberInput, input);
  await requireAdmin(tx, ctx);
  const res = await tx.execute<{ id: string }>(sql`
    update team_memberships set status = 'removed', updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and team_id = ${teamId}::uuid
      and user_id = ${userId}::uuid and status = 'active'
    returning id`);
  if (!res.rows[0]) throw new DomainError("not_found", "Team membership not found.");
  await recordAudit(tx, ctx, { action: "team_membership.removed", targetType: "team", targetId: teamId, metadata: { userId } });
}

export const removeTeamMember = (db: Database, ctx: RequestContext, input: { teamId: string; userId: string }) =>
  withCtx(db, ctx, (tx, c) => removeTeamMemberInTx(tx, c, input));

const DepartmentMemberInput = z.object({ departmentId: Uuid, userId: Uuid });

export async function addDepartmentMemberInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { departmentId: string; userId: string },
): Promise<void> {
  const { departmentId, userId } = parseInput(DepartmentMemberInput, input);
  await requireAdmin(tx, ctx);
  const d = await findDepartment(tx, ctx, departmentId);
  if (!d) throw new DomainError("not_found", "Department not found.");
  if (d.archivedAt) throw new DomainError("conflict", "Department is archived.");
  await requireActiveTarget(tx, ctx, userId);
  const res = await tx.execute<{ id: string }>(sql`
    insert into department_memberships (organization_id, department_id, user_id, status)
    values (${ctx.organizationId}::uuid, ${departmentId}::uuid, ${userId}::uuid, 'active')
    on conflict (department_id, user_id) do update set status = 'active', updated_at = now()
      where department_memberships.status <> 'active'
    returning id`);
  if (res.rows[0]) {
    await recordAudit(tx, ctx, {
      action: "department_membership.added",
      targetType: "department",
      targetId: departmentId,
      metadata: { userId },
    });
  }
}

export const addDepartmentMember = (db: Database, ctx: RequestContext, input: { departmentId: string; userId: string }) =>
  withCtx(db, ctx, (tx, c) => addDepartmentMemberInTx(tx, c, input));

export async function removeDepartmentMemberInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { departmentId: string; userId: string },
): Promise<void> {
  const { departmentId, userId } = parseInput(DepartmentMemberInput, input);
  await requireAdmin(tx, ctx);
  const res = await tx.execute<{ id: string }>(sql`
    update department_memberships set status = 'removed', updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and department_id = ${departmentId}::uuid
      and user_id = ${userId}::uuid and status = 'active'
    returning id`);
  if (!res.rows[0]) throw new DomainError("not_found", "Department membership not found.");
  await recordAudit(tx, ctx, {
    action: "department_membership.removed",
    targetType: "department",
    targetId: departmentId,
    metadata: { userId },
  });
}

export const removeDepartmentMember = (db: Database, ctx: RequestContext, input: { departmentId: string; userId: string }) =>
  withCtx(db, ctx, (tx, c) => removeDepartmentMemberInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Roles and removal
// ---------------------------------------------------------------------------

const PRIVILEGED: readonly CompanyRole[] = ["owner", "admin"];

async function activeOwnerCount(tx: Tx, ctx: RequestContext): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from memberships
    where organization_id = ${ctx.organizationId}::uuid and role = 'owner' and status = 'active'`);
  return Number(res.rows[0]?.n ?? 0);
}

const ChangeRoleInput = z.object({ userId: Uuid, role: z.enum(["owner", "admin", "member"]) });

export async function changeMemberRoleInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { userId: string; role: CompanyRole },
): Promise<{ userId: string; role: CompanyRole }> {
  const { userId, role } = parseInput(ChangeRoleInput, input);
  const actor = await requireAdmin(tx, ctx);
  const target = await requireActiveTarget(tx, ctx, userId);
  if (target.role === role) return { userId, role };
  if ((PRIVILEGED.includes(role) || PRIVILEGED.includes(target.role)) && actor.role !== "owner") {
    throw new DomainError("forbidden", "Only a company owner can assign or remove owner and admin roles.");
  }
  if (target.role === "owner" && (await activeOwnerCount(tx, ctx)) <= 1) {
    throw new DomainError("conflict", "A company must keep at least one owner.");
  }
  await tx.execute(sql`
    update memberships set role = ${role}, updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${userId}::uuid`);
  await recordAudit(tx, ctx, {
    action: "membership.role_changed",
    targetType: "membership",
    targetId: userId,
    metadata: { userId, from: target.role, to: role },
  });
  return { userId, role };
}

export const changeMemberRole = (db: Database, ctx: RequestContext, input: { userId: string; role: CompanyRole }) =>
  withCtx(db, ctx, (tx, c) => changeMemberRoleInTx(tx, c, input));

const RemoveMembershipInput = z.object({ userId: Uuid });

export async function removeMembershipInTx(tx: Tx, ctx: RequestContext, input: { userId: string }): Promise<void> {
  const { userId } = parseInput(RemoveMembershipInput, input);
  const actor = await requireAdmin(tx, ctx);
  const target = await requireActiveTarget(tx, ctx, userId);
  if (PRIVILEGED.includes(target.role) && actor.role !== "owner") {
    throw new DomainError("forbidden", "Only a company owner can remove an owner or admin.");
  }
  if (target.role === "owner" && (await activeOwnerCount(tx, ctx)) <= 1) {
    throw new DomainError("conflict", "A company must keep at least one owner.");
  }
  await tx.execute(sql`
    update memberships set status = 'removed', updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${userId}::uuid`);
  // Briefing grants held while a member end with the membership. Reader
  // grants alone would otherwise keep working (external readers need no
  // membership). Re-granting afterwards is an explicit, audited decision.
  const revoked = await tx.execute<{ id: string; briefing_id: string; role: string }>(sql`
    update briefing_grants set revoked_at = now(), revoked_by = ${ctx.userId}::uuid
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${userId}::uuid and revoked_at is null
    returning id, briefing_id, role`);
  for (const g of revoked.rows) {
    await recordAudit(tx, ctx, {
      action: "grant.revoked",
      targetType: "briefing",
      targetId: g.briefing_id,
      metadata: { grantId: g.id, granteeId: userId, role: g.role, reason: "membership_removed" },
    });
  }
  // MCP connections (dev tokens and OAuth grants) end with the membership too,
  // so a re-added member's previously authorized hosts do not silently regain
  // access. OAuth hosts must authorize again (auth_time after revoked_at).
  const connections = await tx.execute<{ id: string; kind: string }>(sql`
    update integration_connections set status = 'revoked', revoked_at = now(), updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${userId}::uuid and status = 'active'
    returning id, kind`);
  for (const c of connections.rows) {
    await recordAudit(tx, ctx, {
      action: "connection.revoked",
      targetType: "integration_connection",
      targetId: c.id,
      metadata: { kind: c.kind, userId, reason: "membership_removed" },
    });
  }
  await recordAudit(tx, ctx, {
    action: "membership.removed",
    targetType: "membership",
    targetId: userId,
    metadata: { userId, role: target.role, grantsRevoked: revoked.rows.length, connectionsRevoked: connections.rows.length },
  });
  // HOOK(cache): invalidate the user's authorization caches once a cache layer exists.
}

/**
 * Set a company membership to `removed`. Derived department/team access, briefing
 * roles and MCP connections all stop on the next request; briefing grants and
 * connections are revoked, so re-adding the member does not revive them.
 */
export const removeMembership = (db: Database, ctx: RequestContext, input: { userId: string }) =>
  withCtx(db, ctx, (tx, c) => removeMembershipInTx(tx, c, input));
