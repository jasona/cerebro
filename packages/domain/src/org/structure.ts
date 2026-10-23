/**
 * Company structure: departments, teams, the org tree and team reparenting.
 * Reading the tree requires active membership; changes require company owner
 * or admin (ACCESS_MATRIX "Manage departments/teams") and are audited.
 */
import type { Database, Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { DisplayName, parseInput, requireAdmin, requireMember, slugify, toDateOrNull, Uuid, withCtx } from "./shared";

export interface DepartmentDTO {
  id: string;
  name: string;
  slug: string;
  archivedAt: Date | null;
}

export interface TeamDTO {
  id: string;
  departmentId: string;
  name: string;
  slug: string;
  archivedAt: Date | null;
}

export interface OrgTreeTeam extends TeamDTO {
  /** Active team members with active company membership. */
  memberCount: number;
}

export interface OrgTreeDepartment extends DepartmentDTO {
  /** Distinct active people: explicit department members plus members of its teams. */
  memberCount: number;
  teams: OrgTreeTeam[];
}

export interface OrgTree {
  company: { id: string; slug: string; name: string };
  departments: OrgTreeDepartment[];
}

interface DeptRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  archived_at: unknown;
}
interface TeamRow extends DeptRow {
  department_id: string;
}

const toDept = (r: DeptRow): DepartmentDTO => ({ id: r.id, name: r.name, slug: r.slug, archivedAt: toDateOrNull(r.archived_at) });
const toTeam = (r: TeamRow): TeamDTO => ({
  id: r.id,
  departmentId: r.department_id,
  name: r.name,
  slug: r.slug,
  archivedAt: toDateOrNull(r.archived_at),
});

// ---------------------------------------------------------------------------
// Lookups (internal; callers must have checked membership)
// ---------------------------------------------------------------------------

export async function findDepartment(tx: Tx, ctx: RequestContext, departmentId: string): Promise<DepartmentDTO | null> {
  if (!Uuid.safeParse(departmentId).success) return null;
  const res = await tx.execute<DeptRow>(sql`
    select id, name, slug, archived_at from departments
    where organization_id = ${ctx.organizationId}::uuid and id = ${departmentId}::uuid`);
  return res.rows[0] ? toDept(res.rows[0]) : null;
}

export async function findTeam(tx: Tx, ctx: RequestContext, teamId: string): Promise<TeamDTO | null> {
  if (!Uuid.safeParse(teamId).success) return null;
  const res = await tx.execute<TeamRow>(sql`
    select id, department_id, name, slug, archived_at from teams
    where organization_id = ${ctx.organizationId}::uuid and id = ${teamId}::uuid`);
  return res.rows[0] ? toTeam(res.rows[0]) : null;
}

async function requireDepartment(tx: Tx, ctx: RequestContext, id: string, opts: { active?: boolean } = {}) {
  const d = await findDepartment(tx, ctx, id);
  if (!d) throw new DomainError("not_found", "Department not found.");
  if (opts.active && d.archivedAt) throw new DomainError("conflict", "Department is archived.");
  return d;
}

async function requireTeam(tx: Tx, ctx: RequestContext, id: string, opts: { active?: boolean } = {}) {
  const t = await findTeam(tx, ctx, id);
  if (!t) throw new DomainError("not_found", "Team not found.");
  if (opts.active && t.archivedAt) throw new DomainError("conflict", "Team is archived.");
  return t;
}

// ---------------------------------------------------------------------------
// Org tree
// ---------------------------------------------------------------------------

const TreeInput = z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false });

export async function getOrgTreeInTx(tx: Tx, ctx: RequestContext, input: { includeArchived?: boolean } = {}): Promise<OrgTree> {
  const { includeArchived } = parseInput(TreeInput, input);
  await requireMember(tx, ctx);
  const org = ctx.organizationId;
  const company = (
    await tx.execute<{ id: string; slug: string; name: string }>(
      sql`select id, slug, name from organizations where id = ${org}::uuid`,
    )
  ).rows[0];
  if (!company) throw new DomainError("not_found", "Company not found.");

  const archivedFilter = includeArchived ? sql`true` : sql`archived_at is null`;
  const depts = await tx.execute<DeptRow & { member_count: number }>(sql`
    select d.id, d.name, d.slug, d.archived_at,
      (select count(*)::int from (
         select dm.user_id from department_memberships dm
         join memberships m on m.organization_id = dm.organization_id and m.user_id = dm.user_id and m.status = 'active'
         where dm.organization_id = d.organization_id and dm.department_id = d.id and dm.status = 'active'
         union
         select tm.user_id from team_memberships tm
         join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
         join memberships m on m.organization_id = tm.organization_id and m.user_id = tm.user_id and m.status = 'active'
         where tm.organization_id = d.organization_id and t.department_id = d.id and tm.status = 'active'
       ) u) as member_count
    from departments d
    where d.organization_id = ${org}::uuid and ${includeArchived ? sql`true` : sql`d.archived_at is null`}
    order by lower(d.name), d.id`);
  const teams = await tx.execute<TeamRow & { member_count: number }>(sql`
    select t.id, t.department_id, t.name, t.slug, t.archived_at,
      (select count(*)::int from team_memberships tm
       join memberships m on m.organization_id = tm.organization_id and m.user_id = tm.user_id and m.status = 'active'
       where tm.organization_id = t.organization_id and tm.team_id = t.id and tm.status = 'active') as member_count
    from teams t
    where t.organization_id = ${org}::uuid and ${archivedFilter}
    order by lower(t.name), t.id`);

  const departments: OrgTreeDepartment[] = depts.rows.map((d) => ({
    ...toDept(d),
    memberCount: Number(d.member_count),
    teams: teams.rows
      .filter((t) => t.department_id === d.id)
      .map((t) => ({ ...toTeam(t), memberCount: Number(t.member_count) })),
  }));
  return { company, departments };
}

/** Departments with their teams and member counts. Active members only. */
export const getOrgTree = (db: Database, ctx: RequestContext, input: { includeArchived?: boolean } = {}) =>
  withCtx(db, ctx, (tx, c) => getOrgTreeInTx(tx, c, input));

const PathInput = z.object({
  departmentSlug: z.string().trim().min(1).max(100),
  teamSlug: z.string().trim().min(1).max(100).optional(),
});

/** Resolve `/d/[department]/t/[team]` slugs. Archived nodes resolve (provenance). Members only. */
export async function resolveOrgPathInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { departmentSlug: string; teamSlug?: string },
): Promise<{ department: DepartmentDTO; team: TeamDTO | null }> {
  const { departmentSlug, teamSlug } = parseInput(PathInput, input);
  await requireMember(tx, ctx);
  const d = (
    await tx.execute<DeptRow>(sql`
      select id, name, slug, archived_at from departments
      where organization_id = ${ctx.organizationId}::uuid and slug = ${departmentSlug}`)
  ).rows[0];
  if (!d) throw new DomainError("not_found", "Department not found.");
  if (!teamSlug) return { department: toDept(d), team: null };
  const t = (
    await tx.execute<TeamRow>(sql`
      select id, department_id, name, slug, archived_at from teams
      where organization_id = ${ctx.organizationId}::uuid and department_id = ${d.id}::uuid and slug = ${teamSlug}`)
  ).rows[0];
  if (!t) throw new DomainError("not_found", "Team not found.");
  return { department: toDept(d), team: toTeam(t) };
}

export const resolveOrgPath = (db: Database, ctx: RequestContext, input: { departmentSlug: string; teamSlug?: string }) =>
  withCtx(db, ctx, (tx, c) => resolveOrgPathInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Department and team CRUD (owner/admin, audited)
// ---------------------------------------------------------------------------

const Slug = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lower-case letters, digits and hyphens");

async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 56)}-${i}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new DomainError("conflict", "Could not allocate a unique slug.");
}

const CreateDepartmentInput = z.object({ name: DisplayName, slug: Slug.optional() });

export async function createDepartmentInTx(tx: Tx, ctx: RequestContext, input: { name: string; slug?: string }): Promise<DepartmentDTO> {
  const { name, slug } = parseInput(CreateDepartmentInput, input);
  await requireAdmin(tx, ctx);
  const org = ctx.organizationId;
  const taken = async (s: string) =>
    (await tx.execute(sql`select 1 from departments where organization_id = ${org}::uuid and slug = ${s}`)).rows.length > 0;
  if (slug && (await taken(slug))) throw new DomainError("conflict", "A department with this slug already exists.");
  const finalSlug = slug ?? (await uniqueSlug(slugify(name), taken));
  const row = (
    await tx.execute<DeptRow>(sql`
      insert into departments (organization_id, name, slug) values (${org}::uuid, ${name}, ${finalSlug})
      returning id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "department.created", targetType: "department", targetId: row.id, metadata: { slug: finalSlug } });
  return toDept(row);
}

export const createDepartment = (db: Database, ctx: RequestContext, input: { name: string; slug?: string }) =>
  withCtx(db, ctx, (tx, c) => createDepartmentInTx(tx, c, input));

const RenameDepartmentInput = z.object({ departmentId: Uuid, name: DisplayName });

export async function renameDepartmentInTx(tx: Tx, ctx: RequestContext, input: { departmentId: string; name: string }): Promise<DepartmentDTO> {
  const { departmentId, name } = parseInput(RenameDepartmentInput, input);
  await requireAdmin(tx, ctx);
  const before = await requireDepartment(tx, ctx, departmentId);
  const row = (
    await tx.execute<DeptRow>(sql`
      update departments set name = ${name}, updated_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${departmentId}::uuid
      returning id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, {
    action: "department.renamed",
    targetType: "department",
    targetId: departmentId,
    metadata: { from: before.name, to: name },
  });
  return toDept(row);
}

export const renameDepartment = (db: Database, ctx: RequestContext, input: { departmentId: string; name: string }) =>
  withCtx(db, ctx, (tx, c) => renameDepartmentInTx(tx, c, input));

const ArchiveDepartmentInput = z.object({ departmentId: Uuid });

/**
 * Archive a department and its active teams. Briefings keep their home
 * (provenance is never orphaned); archived nodes are hidden from the tree and
 * from authoring destinations.
 */
export async function archiveDepartmentInTx(tx: Tx, ctx: RequestContext, input: { departmentId: string }): Promise<DepartmentDTO> {
  const { departmentId } = parseInput(ArchiveDepartmentInput, input);
  await requireAdmin(tx, ctx);
  const d = await requireDepartment(tx, ctx, departmentId);
  if (d.archivedAt) return d;
  const org = ctx.organizationId;
  const archivedTeams = await tx.execute<{ id: string }>(sql`
    update teams set archived_at = now(), updated_at = now()
    where organization_id = ${org}::uuid and department_id = ${departmentId}::uuid and archived_at is null
    returning id`);
  const row = (
    await tx.execute<DeptRow>(sql`
      update departments set archived_at = now(), updated_at = now()
      where organization_id = ${org}::uuid and id = ${departmentId}::uuid
      returning id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, {
    action: "department.archived",
    targetType: "department",
    targetId: departmentId,
    metadata: { archivedTeamIds: archivedTeams.rows.map((r) => r.id) },
  });
  return toDept(row);
}

export const archiveDepartment = (db: Database, ctx: RequestContext, input: { departmentId: string }) =>
  withCtx(db, ctx, (tx, c) => archiveDepartmentInTx(tx, c, input));

const CreateTeamInput = z.object({ departmentId: Uuid, name: DisplayName, slug: Slug.optional() });

export async function createTeamInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { departmentId: string; name: string; slug?: string },
): Promise<TeamDTO> {
  const { departmentId, name, slug } = parseInput(CreateTeamInput, input);
  await requireAdmin(tx, ctx);
  await requireDepartment(tx, ctx, departmentId, { active: true });
  const org = ctx.organizationId;
  const taken = async (s: string) =>
    (
      await tx.execute(
        sql`select 1 from teams where organization_id = ${org}::uuid and department_id = ${departmentId}::uuid and slug = ${s}`,
      )
    ).rows.length > 0;
  if (slug && (await taken(slug))) throw new DomainError("conflict", "A team with this slug already exists in the department.");
  const finalSlug = slug ?? (await uniqueSlug(slugify(name), taken));
  const row = (
    await tx.execute<TeamRow>(sql`
      insert into teams (organization_id, department_id, name, slug)
      values (${org}::uuid, ${departmentId}::uuid, ${name}, ${finalSlug})
      returning id, department_id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "team.created", targetType: "team", targetId: row.id, metadata: { departmentId, slug: finalSlug } });
  return toTeam(row);
}

export const createTeam = (db: Database, ctx: RequestContext, input: { departmentId: string; name: string; slug?: string }) =>
  withCtx(db, ctx, (tx, c) => createTeamInTx(tx, c, input));

const RenameTeamInput = z.object({ teamId: Uuid, name: DisplayName });

export async function renameTeamInTx(tx: Tx, ctx: RequestContext, input: { teamId: string; name: string }): Promise<TeamDTO> {
  const { teamId, name } = parseInput(RenameTeamInput, input);
  await requireAdmin(tx, ctx);
  const before = await requireTeam(tx, ctx, teamId);
  const row = (
    await tx.execute<TeamRow>(sql`
      update teams set name = ${name}, updated_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${teamId}::uuid
      returning id, department_id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "team.renamed", targetType: "team", targetId: teamId, metadata: { from: before.name, to: name } });
  return toTeam(row);
}

export const renameTeam = (db: Database, ctx: RequestContext, input: { teamId: string; name: string }) =>
  withCtx(db, ctx, (tx, c) => renameTeamInTx(tx, c, input));

const ArchiveTeamInput = z.object({ teamId: Uuid });

export async function archiveTeamInTx(tx: Tx, ctx: RequestContext, input: { teamId: string }): Promise<TeamDTO> {
  const { teamId } = parseInput(ArchiveTeamInput, input);
  await requireAdmin(tx, ctx);
  const t = await requireTeam(tx, ctx, teamId);
  if (t.archivedAt) return t;
  const row = (
    await tx.execute<TeamRow>(sql`
      update teams set archived_at = now(), updated_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${teamId}::uuid
      returning id, department_id, name, slug, archived_at`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "team.archived", targetType: "team", targetId: teamId });
  return toTeam(row);
}

export const archiveTeam = (db: Database, ctx: RequestContext, input: { teamId: string }) =>
  withCtx(db, ctx, (tx, c) => archiveTeamInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Team reparent
// ---------------------------------------------------------------------------

export interface ReparentImpactUser {
  userId: string;
  displayName: string;
}

export interface TeamReparentImpact {
  teamId: string;
  fromDepartmentId: string;
  toDepartmentId: string;
  /** Team members whose derived membership of the old department ends. */
  usersLosingDepartmentAccess: ReparentImpactUser[];
  /** Team members who newly gain derived membership of the new department. */
  usersGainingDepartmentAccess: ReparentImpactUser[];
  /**
   * Briefings with a department audience on the old or new department whose
   * derived readership changes. Ids and counts only; titles are not shown to
   * admins who may not be able to read them (D09).
   */
  departmentAudienceBriefings: { count: number; briefingIds: string[] };
  /** Briefings homed at the team; their home department moves with the team. Audience is unchanged. */
  homedBriefings: { count: number; briefingIds: string[] };
}

const ReparentInput = z.object({ teamId: Uuid, newDepartmentId: Uuid });

async function computeImpact(tx: Tx, ctx: RequestContext, teamId: string, newDepartmentId: string): Promise<TeamReparentImpact> {
  const team = await requireTeam(tx, ctx, teamId, { active: true });
  await requireDepartment(tx, ctx, newDepartmentId, { active: true });
  if (team.departmentId === newDepartmentId) throw new DomainError("validation", "The team is already in that department.");
  const org = ctx.organizationId;
  const from = team.departmentId;

  // Active team members (with active company membership) and whether they
  // keep / already have derived access to each department without this team.
  const members = await tx.execute<{ user_id: string; display_name: string; keeps_old: boolean; has_new: boolean }>(sql`
    select tm.user_id, u.display_name,
      (exists (select 1 from department_memberships dm
               where dm.organization_id = tm.organization_id and dm.department_id = ${from}::uuid
                 and dm.user_id = tm.user_id and dm.status = 'active')
       or exists (select 1 from team_memberships tm2 join teams t2 on t2.organization_id = tm2.organization_id and t2.id = tm2.team_id
                  where tm2.organization_id = tm.organization_id and tm2.user_id = tm.user_id and tm2.status = 'active'
                    and t2.department_id = ${from}::uuid and t2.id <> ${teamId}::uuid)) as keeps_old,
      (exists (select 1 from department_memberships dm
               where dm.organization_id = tm.organization_id and dm.department_id = ${newDepartmentId}::uuid
                 and dm.user_id = tm.user_id and dm.status = 'active')
       or exists (select 1 from team_memberships tm2 join teams t2 on t2.organization_id = tm2.organization_id and t2.id = tm2.team_id
                  where tm2.organization_id = tm.organization_id and tm2.user_id = tm.user_id and tm2.status = 'active'
                    and t2.department_id = ${newDepartmentId}::uuid)) as has_new
    from team_memberships tm
    join memberships m on m.organization_id = tm.organization_id and m.user_id = tm.user_id and m.status = 'active'
    join users u on u.id = tm.user_id
    where tm.organization_id = ${org}::uuid and tm.team_id = ${teamId}::uuid and tm.status = 'active'
    order by lower(u.display_name), tm.user_id`);
  const losing = members.rows.filter((r) => !r.keeps_old).map((r) => ({ userId: r.user_id, displayName: r.display_name }));
  const gaining = members.rows.filter((r) => !r.has_new).map((r) => ({ userId: r.user_id, displayName: r.display_name }));

  let audienceIds: string[] = [];
  if (losing.length > 0 || gaining.length > 0) {
    const affectedDepts = [...(losing.length ? [from] : []), ...(gaining.length ? [newDepartmentId] : [])];
    const res = await tx.execute<{ id: string }>(sql`
      select id from briefings
      where organization_id = ${org}::uuid and visibility = 'department'
        and audience_department_id in (${sql.join(
          affectedDepts.map((d) => sql`${d}::uuid`),
          sql`, `,
        )})
      order by id`);
    audienceIds = res.rows.map((r) => r.id);
  }
  const homed = await tx.execute<{ id: string }>(sql`
    select id from briefings where organization_id = ${org}::uuid and home_team_id = ${teamId}::uuid order by id`);

  return {
    teamId,
    fromDepartmentId: from,
    toDepartmentId: newDepartmentId,
    usersLosingDepartmentAccess: losing,
    usersGainingDepartmentAccess: gaining,
    departmentAudienceBriefings: { count: audienceIds.length, briefingIds: audienceIds },
    homedBriefings: { count: homed.rows.length, briefingIds: homed.rows.map((r) => r.id) },
  };
}

export async function previewTeamReparentInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { teamId: string; newDepartmentId: string },
): Promise<TeamReparentImpact> {
  const { teamId, newDepartmentId } = parseInput(ReparentInput, input);
  await requireAdmin(tx, ctx);
  return computeImpact(tx, ctx, teamId, newDepartmentId);
}

/** Impact of moving a team to another department, without changing anything. */
export const previewTeamReparent = (db: Database, ctx: RequestContext, input: { teamId: string; newDepartmentId: string }) =>
  withCtx(db, ctx, (tx, c) => previewTeamReparentInTx(tx, c, input));

export async function reparentTeamInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { teamId: string; newDepartmentId: string },
): Promise<{ team: TeamDTO; impact: TeamReparentImpact }> {
  const { teamId, newDepartmentId } = parseInput(ReparentInput, input);
  await requireAdmin(tx, ctx);
  const impact = await computeImpact(tx, ctx, teamId, newDepartmentId);
  const org = ctx.organizationId;
  const team = (await findTeam(tx, ctx, teamId))!;
  const clash = await tx.execute(sql`
    select 1 from teams where organization_id = ${org}::uuid and department_id = ${newDepartmentId}::uuid and slug = ${team.slug}`);
  if (clash.rows.length) throw new DomainError("conflict", "The new department already has a team with this slug.");

  // One statement so the composite (organization, department, team) foreign
  // keys from briefing homes and authoring preferences are checked only after
  // the team and its referencing rows have all moved. Data-modifying CTEs
  // always run to completion even though the outer update does not read them.
  const row = (
    await tx.execute<TeamRow>(sql`
      with moved_briefings as (
        update briefings set home_department_id = ${newDepartmentId}::uuid
        where organization_id = ${org}::uuid and home_team_id = ${teamId}::uuid
        returning id
      ), moved_preferences as (
        update authoring_preferences set default_department_id = ${newDepartmentId}::uuid, updated_at = now()
        where organization_id = ${org}::uuid and default_team_id = ${teamId}::uuid
        returning id
      )
      update teams set department_id = ${newDepartmentId}::uuid, updated_at = now()
      where organization_id = ${org}::uuid and id = ${teamId}::uuid
      returning id, department_id, name, slug, archived_at`)
  ).rows[0];
  if (!row) throw new DomainError("not_found", "Team not found.");

  await recordAudit(tx, ctx, {
    action: "team.reparented",
    targetType: "team",
    targetId: teamId,
    metadata: {
      fromDepartmentId: impact.fromDepartmentId,
      toDepartmentId: impact.toDepartmentId,
      usersLosingDepartmentAccess: impact.usersLosingDepartmentAccess.length,
      usersGainingDepartmentAccess: impact.usersGainingDepartmentAccess.length,
      departmentAudienceBriefingIds: impact.departmentAudienceBriefings.briefingIds,
      homedBriefingIds: impact.homedBriefings.briefingIds,
    },
  });
  // HOOK(cache): invalidate authorization caches for the affected users and
  // briefings here once a cache layer exists. There is none yet: every access
  // check reads current memberships, so the move takes effect immediately.
  return { team: toTeam(row), impact };
}

/** Move a team to another department (owner/admin, audited). Returns the applied impact. */
export const reparentTeam = (db: Database, ctx: RequestContext, input: { teamId: string; newDepartmentId: string }) =>
  withCtx(db, ctx, (tx, c) => reparentTeamInTx(tx, c, input));
