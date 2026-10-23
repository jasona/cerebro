/**
 * Internal helpers shared by briefings/ and publication/. Not part of the
 * public domain API except for the DTO types re-exported from index.ts.
 */
import {
  briefingGrants,
  briefings,
  departments,
  organizations,
  teams,
  users,
  withAuthContext,
  type Database,
  type Tx,
  type Visibility,
} from "@cerebro/database";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { RequestContext } from "../context";
import { DomainError } from "../errors";

export const Uuid = z.string().uuid();

/**
 * Optional hook so a caller (e.g. the MCP adapter's idempotent operation
 * runner) can record its own rows atomically in the same transaction as the
 * domain change. Called after the change succeeded, before commit.
 */
export type ServiceOperationHook<R> = (tx: Tx, result: R) => Promise<void>;
export interface ServiceOptions<R> {
  operation?: ServiceOperationHook<R>;
}

/** Validate `input` with `schema`, throwing DomainError("validation") with field issues. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw new DomainError("validation", "Invalid input.", {
      issues: res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return res.data;
}

export function parseCtx(ctx: RequestContext): RequestContext {
  const res = RequestContext.safeParse(ctx);
  if (!res.success) throw new DomainError("unauthenticated", "Invalid request context.");
  return res.data;
}

/** Open an auth-context transaction for `ctx` (RLS as cerebro_app). */
export function inAuthTx<T>(db: Database, ctx: RequestContext, fn: (tx: Tx, ctx: RequestContext) => Promise<T>): Promise<T> {
  const c = parseCtx(ctx);
  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, (tx) =>
    fn(tx, c),
  );
}

/** Postgres SQLSTATE from a driver error, unwrapping Drizzle's `cause` chain. */
export function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export type BriefingRow = typeof briefings.$inferSelect;

/** Briefing row in the context company (RLS also restricts to it), or null. */
export async function loadBriefingRow(tx: Tx, ctx: RequestContext, briefingId: string, opts: { forUpdate?: boolean } = {}) {
  if (!Uuid.safeParse(briefingId).success) return null;
  const q = tx
    .select()
    .from(briefings)
    .where(and(eq(briefings.id, briefingId), eq(briefings.organizationId, ctx.organizationId)));
  const rows = opts.forUpdate ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/** Resolve `{ briefingId } | { slug }` to a briefing id in the context company; not_found otherwise. */
export const BriefingLocator = z.union([
  z.string().uuid(),
  z.object({ briefingId: z.string().uuid() }),
  z.object({ slug: z.string().min(1).max(120) }),
]);
export type BriefingLocator = z.infer<typeof BriefingLocator>;

export async function resolveBriefingId(tx: Tx, ctx: RequestContext, locator: BriefingLocator): Promise<string> {
  if (typeof locator === "string") return locator;
  if ("briefingId" in locator) return locator.briefingId;
  const rows = await tx
    .select({ id: briefings.id })
    .from(briefings)
    .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.slug, locator.slug)));
  if (!rows[0]) throw new DomainError("not_found", "Briefing not found.");
  return rows[0].id;
}

export async function orgSlugOf(tx: Tx, ctx: RequestContext): Promise<string> {
  const rows = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, ctx.organizationId));
  if (!rows[0]) throw new DomainError("not_found", "Company not found.");
  return rows[0].slug;
}

export const canonicalPath = (orgSlug: string, briefingSlug: string) => `/c/${orgSlug}/b/${briefingSlug}`;
export const pinnedPath = (orgSlug: string, briefingSlug: string, n: number) => `/c/${orgSlug}/b/${briefingSlug}/v/${n}`;

// ---------------------------------------------------------------------------
// Home and audience
// ---------------------------------------------------------------------------

export const HomeSpec = z
  .object({ departmentId: z.string().uuid().nullish(), teamId: z.string().uuid().nullish() })
  .strict();
export type HomeSpec = z.infer<typeof HomeSpec>;

export const AudienceSpec = z
  .object({
    visibility: z.enum(["company", "department", "team", "restricted"]),
    departmentId: z.string().uuid().nullish(),
    teamId: z.string().uuid().nullish(),
    /** Named readers. Reader grants are created immediately (see README in briefings/index.ts). */
    readerUserIds: z.array(z.string().uuid()).max(200).optional(),
  })
  .strict()
  .superRefine((a, c) => {
    if (a.visibility === "department" && (!a.departmentId || a.teamId)) {
      c.addIssue({ code: "custom", message: "A department audience needs departmentId and no teamId.", path: ["departmentId"] });
    }
    if (a.visibility === "team" && (!a.teamId || a.departmentId)) {
      c.addIssue({ code: "custom", message: "A team audience needs teamId and no departmentId.", path: ["teamId"] });
    }
    if ((a.visibility === "company" || a.visibility === "restricted") && (a.departmentId || a.teamId)) {
      c.addIssue({ code: "custom", message: "Company and restricted audiences take no department or team.", path: ["visibility"] });
    }
  });
export type AudienceSpec = z.infer<typeof AudienceSpec>;

export interface ResolvedHome {
  departmentId: string | null;
  teamId: string | null;
}
export interface ResolvedAudience {
  visibility: Visibility;
  departmentId: string | null;
  teamId: string | null;
}

/** Validate a home in the context company: active department; a team must belong to its department. */
export async function resolveHome(tx: Tx, ctx: RequestContext, home: HomeSpec): Promise<ResolvedHome> {
  if (home.teamId) {
    const [t] = await tx
      .select({ id: teams.id, departmentId: teams.departmentId })
      .from(teams)
      .where(and(eq(teams.id, home.teamId), eq(teams.organizationId, ctx.organizationId), isNull(teams.archivedAt)));
    if (!t) throw new DomainError("validation", "Unknown team for this company.", { field: "home.teamId" });
    if (home.departmentId && home.departmentId !== t.departmentId) {
      throw new DomainError("validation", "The team does not belong to that department.", { field: "home.teamId" });
    }
    return { departmentId: t.departmentId, teamId: t.id };
  }
  if (home.departmentId) {
    await requireDepartment(tx, ctx, home.departmentId, "home.departmentId");
    return { departmentId: home.departmentId, teamId: null };
  }
  return { departmentId: null, teamId: null };
}

/**
 * Home authorization (D10). Company owners and admins may home a briefing
 * anywhere in the company, since they manage structure. Other active members
 * may use only destinations they could publish into (integration
 * `getAuthoringContext` semantics): the company home; a department through
 * explicit department membership or membership of one of its teams; a team
 * through team membership. `home` must already be resolved by `resolveHome`.
 */
export async function assertHomeAuthorized(tx: Tx, ctx: RequestContext, home: ResolvedHome): Promise<void> {
  const res = await tx.execute<{ role: string; ok: boolean }>(sql`
    select m.role,
      case
        when ${home.teamId}::uuid is not null then exists (
          select 1 from team_memberships tm
          where tm.organization_id = m.organization_id and tm.team_id = ${home.teamId}::uuid
            and tm.user_id = m.user_id and tm.status = 'active')
        when ${home.departmentId}::uuid is not null then exists (
            select 1 from department_memberships dm
            where dm.organization_id = m.organization_id and dm.department_id = ${home.departmentId}::uuid
              and dm.user_id = m.user_id and dm.status = 'active')
          or exists (
            select 1 from team_memberships tm join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
            where tm.organization_id = m.organization_id and t.department_id = ${home.departmentId}::uuid
              and t.archived_at is null and tm.user_id = m.user_id and tm.status = 'active')
        else true
      end as ok
    from memberships m
    where m.organization_id = ${ctx.organizationId}::uuid and m.user_id = ${ctx.userId}::uuid and m.status = 'active'`);
  const row = res.rows[0];
  if (!row) throw new DomainError("forbidden", "Only active company members can place briefings.");
  if (row.role === "owner" || row.role === "admin" || row.ok) return;
  const field = home.teamId ? "home.teamId" : "home.departmentId";
  throw new DomainError("forbidden", "You can only place a briefing in the company or in departments and teams you belong to.", {
    field,
    reason: "not_authorized",
  });
}

async function requireDepartment(tx: Tx, ctx: RequestContext, id: string, field: string) {
  const [d] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.id, id), eq(departments.organizationId, ctx.organizationId), isNull(departments.archivedAt)));
  if (!d) throw new DomainError("validation", "Unknown department for this company.", { field });
}

/** Validate audience resources in the context company. Named readers are validated when their grants are written. */
export async function resolveAudience(tx: Tx, ctx: RequestContext, a: AudienceSpec): Promise<ResolvedAudience> {
  if (a.visibility === "department") await requireDepartment(tx, ctx, a.departmentId!, "audience.departmentId");
  if (a.visibility === "team") {
    const [t] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, a.teamId!), eq(teams.organizationId, ctx.organizationId), isNull(teams.archivedAt)));
    if (!t) throw new DomainError("validation", "Unknown team for this company.", { field: "audience.teamId" });
  }
  return {
    visibility: a.visibility,
    departmentId: a.visibility === "department" ? a.departmentId! : null,
    teamId: a.visibility === "team" ? a.teamId! : null,
  };
}

/**
 * Named readers given by user id must be active members of the context
 * company or already hold an active grant on this briefing (`briefingId` is
 * null for a new briefing). Anyone else, including an unknown uuid, gets the
 * same validation error, so the check is not an existence oracle for global
 * user ids. External readers are added by email via grantAccess/invitations.
 */
export async function assertNamedReadersEligible(
  tx: Tx,
  ctx: RequestContext,
  briefingId: string | null,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const res = await tx.execute<{ user_id: string }>(sql`
    select m.user_id from memberships m
    where m.organization_id = ${ctx.organizationId}::uuid and m.status = 'active'
      and m.user_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    union
    select g.user_id from briefing_grants g
    where ${briefingId}::uuid is not null and g.organization_id = ${ctx.organizationId}::uuid
      and g.briefing_id = ${briefingId}::uuid and g.revoked_at is null
      and g.user_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  const eligible = new Set(res.rows.map((r) => r.user_id));
  for (const userId of ids) {
    if (!eligible.has(userId)) throw new DomainError("validation", "Unknown reader.", { field: "readerUserIds", userId });
  }
}

/**
 * Ensure an active, unscoped reader grant exists for each user. Users must
 * exist (FK, checked by Postgres regardless of RLS); they need not be company
 * members, since external readers may hold reader grants.
 */
export async function ensureReaderGrants(tx: Tx, ctx: RequestContext, briefingId: string, userIds: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  const existing = new Set(await activeReaderIds(tx, ctx, briefingId));
  for (const userId of new Set(userIds)) {
    if (existing.has(userId)) continue;
    try {
      // Savepoint so an FK violation does not abort the caller's transaction before we translate it.
      await tx.transaction(async (sp) => {
        await sp.insert(briefingGrants).values({
          organizationId: ctx.organizationId,
          briefingId,
          userId,
          role: "reader",
          issuedBy: ctx.userId,
        });
      });
      created.push(userId);
    } catch (e) {
      if (pgCode(e) === "23503") throw new DomainError("validation", "Unknown reader.", { field: "readerUserIds", userId });
      throw e;
    }
  }
  return created;
}

/** Active unscoped reader grants (the named-reader part of the audience), sorted. */
export async function activeReaderIds(tx: Tx, ctx: RequestContext, briefingId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: briefingGrants.userId })
    .from(briefingGrants)
    .where(
      and(
        eq(briefingGrants.organizationId, ctx.organizationId),
        eq(briefingGrants.briefingId, briefingId),
        eq(briefingGrants.role, "reader"),
        isNull(briefingGrants.revisionId),
        isNull(briefingGrants.revokedAt),
      ),
    )
    .orderBy(asc(briefingGrants.userId));
  return rows.map((r) => r.userId);
}

// ---------------------------------------------------------------------------
// DTOs for home / audience
// ---------------------------------------------------------------------------

export interface OrgUnitRef {
  id: string;
  name: string;
  slug: string;
}
export interface HomeDTO {
  level: "company" | "department" | "team";
  department: OrgUnitRef | null;
  team: OrgUnitRef | null;
  /** e.g. "Acme", "Acme / Product", "Acme / Product / Platform". */
  label: string;
}
export interface UserRef {
  userId: string;
  displayName: string;
}
export interface AudienceDTO {
  visibility: Visibility;
  department: OrgUnitRef | null;
  team: OrgUnitRef | null;
  /** Named readers (active unscoped reader grants). Only returned to viewers holding publish or manage_access. */
  namedReaders?: UserRef[];
  /** e.g. "Everyone at Acme", "Product department", "Platform team", "Named readers only". */
  label: string;
}

async function unitRefs(tx: Tx, ctx: RequestContext, deptIds: (string | null)[], teamIds: (string | null)[]) {
  const d = new Map<string, OrgUnitRef>();
  const t = new Map<string, OrgUnitRef>();
  const ds = deptIds.filter((x): x is string => !!x);
  const ts = teamIds.filter((x): x is string => !!x);
  if (ds.length) {
    const rows = await tx
      .select({ id: departments.id, name: departments.name, slug: departments.slug })
      .from(departments)
      .where(and(eq(departments.organizationId, ctx.organizationId), sql`${departments.id} in (${sql.join(ds.map((x) => sql`${x}::uuid`), sql`, `)})`));
    for (const r of rows) d.set(r.id, r);
  }
  if (ts.length) {
    const rows = await tx
      .select({ id: teams.id, name: teams.name, slug: teams.slug })
      .from(teams)
      .where(and(eq(teams.organizationId, ctx.organizationId), sql`${teams.id} in (${sql.join(ts.map((x) => sql`${x}::uuid`), sql`, `)})`));
    for (const r of rows) t.set(r.id, r);
  }
  return { d, t };
}

export async function userRefs(tx: Tx, ids: readonly string[]): Promise<UserRef[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select({ userId: users.id, displayName: users.displayName })
    .from(users)
    .where(sql`${users.id} in (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)})`);
  const byId = new Map(rows.map((r) => [r.userId, r]));
  // Users hidden by RLS still appear, without a name, so the reviewed audience is never silently shortened.
  return ids.map((id) => byId.get(id) ?? { userId: id, displayName: "Unknown user" });
}

export async function describePlacement(
  tx: Tx,
  ctx: RequestContext,
  home: ResolvedHome,
  audience: ResolvedAudience,
  namedReaderIds?: readonly string[],
): Promise<{ home: HomeDTO; audience: AudienceDTO }> {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId));
  const orgName = org?.name ?? "Company";
  const { d, t } = await unitRefs(tx, ctx, [home.departmentId, audience.departmentId], [home.teamId, audience.teamId]);
  const hd = home.departmentId ? (d.get(home.departmentId) ?? null) : null;
  const ht = home.teamId ? (t.get(home.teamId) ?? null) : null;
  const homeDto: HomeDTO = {
    level: ht ? "team" : hd ? "department" : "company",
    department: hd,
    team: ht,
    label: [orgName, hd?.name, ht?.name].filter(Boolean).join(" / "),
  };
  const ad = audience.departmentId ? (d.get(audience.departmentId) ?? null) : null;
  const at = audience.teamId ? (t.get(audience.teamId) ?? null) : null;
  const label =
    audience.visibility === "company"
      ? `Everyone at ${orgName}`
      : audience.visibility === "department"
        ? `${ad?.name ?? "Unknown"} department`
        : audience.visibility === "team"
          ? `${at?.name ?? "Unknown"} team`
          : "Named readers only";
  const audienceDto: AudienceDTO = { visibility: audience.visibility, department: ad, team: at, label };
  if (namedReaderIds) audienceDto.namedReaders = await userRefs(tx, namedReaderIds);
  return { home: homeDto, audience: audienceDto };
}

export const homeOf = (b: BriefingRow): ResolvedHome => ({ departmentId: b.homeDepartmentId, teamId: b.homeTeamId });
export const audienceOf = (b: BriefingRow): ResolvedAudience => ({
  visibility: b.visibility as Visibility,
  departmentId: b.audienceDepartmentId,
  teamId: b.audienceTeamId,
});

/** URL-safe slug from a title; never empty. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "brief";
}
