/**
 * Authoring destinations for the connected LLM and the studio: which homes
 * the user may publish into, remembered preferences (revalidated on read),
 * natural-language destination resolution and audience resolution.
 *
 * Destinations by membership (ACCESS_MATRIX): any active member may create in
 * the company home; department homes need explicit department membership or
 * membership of one of its teams; team homes need team membership. Archived
 * departments and teams are never destinations. Ids supplied by an LLM are
 * untrusted and always re-resolved inside the context company.
 */
import type { Database, Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { CompanyRole } from "../access/index";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { findDepartment, findTeam } from "../org/structure";
import { normalizeEmail, parseInput, requireMember, toDateOrNull, Uuid, withCtx } from "../org/shared";

export type DestinationKind = "company" | "department" | "team";

export interface DestinationHome {
  kind: DestinationKind;
  departmentId: string | null;
  departmentName: string | null;
  departmentSlug: string | null;
  teamId: string | null;
  teamName: string | null;
  teamSlug: string | null;
  /** Display path, e.g. "Acme / Product / Platform". */
  label: string;
}

export interface AuthorizedDestinations {
  company: { id: string; slug: string; name: string };
  companyHome: DestinationHome;
  departments: DestinationHome[];
  teams: DestinationHome[];
}

interface Company {
  id: string;
  slug: string;
  name: string;
}

const companyHome = (c: Company): DestinationHome => ({
  kind: "company",
  departmentId: null,
  departmentName: null,
  departmentSlug: null,
  teamId: null,
  teamName: null,
  teamSlug: null,
  label: c.name,
});

const deptHome = (c: Company, d: { id: string; name: string; slug: string }): DestinationHome => ({
  ...companyHome(c),
  kind: "department",
  departmentId: d.id,
  departmentName: d.name,
  departmentSlug: d.slug,
  label: `${c.name} / ${d.name}`,
});

const teamHome = (
  c: Company,
  d: { id: string; name: string; slug: string },
  t: { id: string; name: string; slug: string },
): DestinationHome => ({
  ...deptHome(c, d),
  kind: "team",
  teamId: t.id,
  teamName: t.name,
  teamSlug: t.slug,
  label: `${c.name} / ${d.name} / ${t.name}`,
});

async function loadCompany(tx: Tx, ctx: RequestContext): Promise<Company> {
  const c = (
    await tx.execute<{ id: string; slug: string; name: string }>(
      sql`select id, slug, name from organizations where id = ${ctx.organizationId}::uuid`,
    )
  ).rows[0];
  if (!c) throw new DomainError("not_found", "Company not found.");
  return c;
}

/** Destinations the user may publish into. Requires active membership. */
export async function listAuthorizedDestinationsInTx(tx: Tx, ctx: RequestContext): Promise<AuthorizedDestinations> {
  const membership = await requireMember(tx, ctx);
  const company = await loadCompany(tx, ctx);
  // D10: owners and admins may home briefs anywhere in the company, as in the studio.
  const anywhere = membership.role === "owner" || membership.role === "admin";
  const teamRows = await tx.execute<{ t_id: string; t_name: string; t_slug: string; d_id: string; d_name: string; d_slug: string }>(sql`
    select t.id as t_id, t.name as t_name, t.slug as t_slug, d.id as d_id, d.name as d_name, d.slug as d_slug
    from team_memberships tm
    join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
    join departments d on d.organization_id = t.organization_id and d.id = t.department_id
    where tm.organization_id = ${ctx.organizationId}::uuid and tm.user_id = ${ctx.userId}::uuid and tm.status = 'active'
      and t.archived_at is null and d.archived_at is null
    order by lower(d.name), lower(t.name), t.id`);
  const allTeamRows = anywhere
    ? await tx.execute<{ t_id: string; t_name: string; t_slug: string; d_id: string; d_name: string; d_slug: string }>(sql`
        select t.id as t_id, t.name as t_name, t.slug as t_slug, d.id as d_id, d.name as d_name, d.slug as d_slug
        from teams t
        join departments d on d.organization_id = t.organization_id and d.id = t.department_id
        where t.organization_id = ${ctx.organizationId}::uuid and t.archived_at is null and d.archived_at is null
        order by lower(d.name), lower(t.name), t.id`)
    : teamRows;
  const deptRows = await tx.execute<{ id: string; name: string; slug: string }>(sql`
    select d.id, d.name, d.slug from departments d
    where d.organization_id = ${ctx.organizationId}::uuid and d.archived_at is null
      and (${anywhere}::boolean or exists (select 1 from department_memberships dm where dm.organization_id = d.organization_id
                     and dm.department_id = d.id and dm.user_id = ${ctx.userId}::uuid and dm.status = 'active')
           or exists (select 1 from team_memberships tm join teams t on t.organization_id = tm.organization_id and t.id = tm.team_id
                      where tm.organization_id = d.organization_id and t.department_id = d.id and t.archived_at is null
                        and tm.user_id = ${ctx.userId}::uuid and tm.status = 'active'))
    order by lower(d.name), d.id`);
  return {
    company,
    companyHome: companyHome(company),
    departments: deptRows.rows.map((d) => deptHome(company, d)),
    teams: allTeamRows.rows.map((r) =>
      teamHome(company, { id: r.d_id, name: r.d_name, slug: r.d_slug }, { id: r.t_id, name: r.t_name, slug: r.t_slug }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Authoring preferences
// ---------------------------------------------------------------------------

export type StaleReason = "archived" | "not_accessible";

export interface PreferenceRef {
  id: string;
  name: string;
  slug: string;
  /** True when the remembered destination is archived or no longer accessible; it is not used. */
  stale: boolean;
  staleReason: StaleReason | null;
}

export interface AuthoringPreferences {
  defaultDepartment: PreferenceRef | null;
  defaultTeam: PreferenceRef | null;
  preferredStyle: string | null;
  /** The usable remembered home, or null when none is set or it is stale. Never a silent fallback. */
  defaultHome: DestinationHome | null;
  updatedAt: Date | null;
}

interface PrefRow extends Record<string, unknown> {
  default_department_id: string | null;
  default_team_id: string | null;
  preferred_style: string | null;
  updated_at: unknown;
}

export async function getAuthoringPreferencesInTx(tx: Tx, ctx: RequestContext): Promise<AuthoringPreferences> {
  const dest = await listAuthorizedDestinationsInTx(tx, ctx);
  const row = (
    await tx.execute<PrefRow>(sql`
      select default_department_id, default_team_id, preferred_style, updated_at from authoring_preferences
      where organization_id = ${ctx.organizationId}::uuid and user_id = ${ctx.userId}::uuid`)
  ).rows[0];
  if (!row) return { defaultDepartment: null, defaultTeam: null, preferredStyle: null, defaultHome: null, updatedAt: null };

  let defaultDepartment: PreferenceRef | null = null;
  let defaultTeam: PreferenceRef | null = null;
  let defaultHome: DestinationHome | null = null;

  if (row.default_department_id) {
    const d = await findDepartment(tx, ctx, row.default_department_id);
    const authorized = dest.departments.find((x) => x.departmentId === row.default_department_id);
    const staleReason: StaleReason | null = !d || d.archivedAt ? "archived" : authorized ? null : "not_accessible";
    defaultDepartment = { id: row.default_department_id, name: d?.name ?? "", slug: d?.slug ?? "", stale: staleReason !== null, staleReason };
    if (!row.default_team_id && authorized && !staleReason) defaultHome = authorized;
  }
  if (row.default_team_id) {
    const t = await findTeam(tx, ctx, row.default_team_id);
    const parentArchived = defaultDepartment?.staleReason === "archived";
    const authorized = dest.teams.find((x) => x.teamId === row.default_team_id);
    const staleReason: StaleReason | null = !t || t.archivedAt || parentArchived ? "archived" : authorized ? null : "not_accessible";
    defaultTeam = { id: row.default_team_id, name: t?.name ?? "", slug: t?.slug ?? "", stale: staleReason !== null, staleReason };
    if (authorized && !staleReason) defaultHome = authorized;
  }
  return {
    defaultDepartment,
    defaultTeam,
    preferredStyle: row.preferred_style,
    defaultHome,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/** Remembered authoring defaults, revalidated against current membership and archive state. */
export const getAuthoringPreferences = (db: Database, ctx: RequestContext) =>
  withCtx(db, ctx, (tx, c) => getAuthoringPreferencesInTx(tx, c));

const SetPrefsInput = z.object({
  defaultDepartmentId: Uuid.nullish(),
  defaultTeamId: Uuid.nullish(),
  preferredStyle: z.string().trim().max(500).nullish(),
});

export interface SetAuthoringPreferencesInput {
  /** Omit to keep; null to clear. Implied by `defaultTeamId` when a team is set. */
  defaultDepartmentId?: string | null;
  /** Omit to keep; null to clear. */
  defaultTeamId?: string | null;
  preferredStyle?: string | null;
}

export async function setAuthoringPreferencesInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: SetAuthoringPreferencesInput,
): Promise<AuthoringPreferences> {
  const input = parseInput(SetPrefsInput, rawInput);
  const dest = await listAuthorizedDestinationsInTx(tx, ctx);
  const current = (
    await tx.execute<PrefRow>(sql`
      select default_department_id, default_team_id, preferred_style, updated_at from authoring_preferences
      where organization_id = ${ctx.organizationId}::uuid and user_id = ${ctx.userId}::uuid`)
  ).rows[0];

  let teamId = input.defaultTeamId === undefined ? (current?.default_team_id ?? null) : input.defaultTeamId;
  let departmentId = input.defaultDepartmentId === undefined ? (current?.default_department_id ?? null) : input.defaultDepartmentId;
  // Clearing the department clears the team that depends on it.
  if (input.defaultDepartmentId === null && input.defaultTeamId === undefined) teamId = null;

  if (input.defaultTeamId) {
    const t = dest.teams.find((x) => x.teamId === input.defaultTeamId);
    if (!t) throw new DomainError("forbidden", "You can only remember a team you belong to.", { reason: "not_authorized" });
    if (input.defaultDepartmentId && input.defaultDepartmentId !== t.departmentId) {
      throw new DomainError("validation", "The team does not belong to that department.");
    }
    departmentId = t.departmentId;
    teamId = t.teamId;
  } else if (input.defaultDepartmentId) {
    const d = dest.departments.find((x) => x.departmentId === input.defaultDepartmentId);
    if (!d) throw new DomainError("forbidden", "You can only remember a department you belong to.", { reason: "not_authorized" });
    if (teamId) {
      const t = await findTeam(tx, ctx, teamId);
      if (!t || t.departmentId !== d.departmentId) teamId = null;
    }
  }
  const preferredStyle = input.preferredStyle === undefined ? (current?.preferred_style ?? null) : input.preferredStyle || null;

  await tx.execute(sql`
    insert into authoring_preferences (organization_id, user_id, default_department_id, default_team_id, preferred_style)
    values (${ctx.organizationId}::uuid, ${ctx.userId}::uuid, ${departmentId}::uuid, ${teamId}::uuid, ${preferredStyle})
    on conflict (organization_id, user_id) do update set
      default_department_id = excluded.default_department_id,
      default_team_id = excluded.default_team_id,
      preferred_style = excluded.preferred_style,
      updated_at = now()`);
  return getAuthoringPreferencesInTx(tx, ctx);
}

/** Remember explicit defaults. Only destinations the user may currently publish into are accepted. */
export const setAuthoringPreferences = (db: Database, ctx: RequestContext, input: SetAuthoringPreferencesInput) =>
  withCtx(db, ctx, (tx, c) => setAuthoringPreferencesInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Authoring context
// ---------------------------------------------------------------------------

export interface AuthoringCapabilities {
  /** Any active member may create a brief (in any destination listed). */
  canCreateBriefs: boolean;
  /** Owners of a brief may publish it (D05); per-brief capabilities still apply. */
  canPublishOwnBriefs: boolean;
  canManageStructure: boolean;
  canManageMemberships: boolean;
  canCreateConnectionToken: boolean;
}

export interface AuthoringContext {
  company: { id: string; slug: string; name: string };
  user: { id: string; displayName: string; role: CompanyRole };
  connectionId: string | null;
  destinations: { company: DestinationHome; departments: DestinationHome[]; teams: DestinationHome[] };
  preferences: AuthoringPreferences;
  visibilityOptions: readonly ["company", "department", "team", "restricted"];
  defaultVisibility: "company";
  capabilities: AuthoringCapabilities;
}

export async function getAuthoringContextInTx(tx: Tx, ctx: RequestContext): Promise<AuthoringContext> {
  const membership = await requireMember(tx, ctx);
  const dest = await listAuthorizedDestinationsInTx(tx, ctx);
  const preferences = await getAuthoringPreferencesInTx(tx, ctx);
  const user = (await tx.execute<{ display_name: string }>(sql`select display_name from users where id = ${ctx.userId}::uuid`)).rows[0];
  const admin = membership.role === "owner" || membership.role === "admin";
  return {
    company: dest.company,
    user: { id: ctx.userId, displayName: user?.display_name ?? "", role: membership.role },
    connectionId: ctx.connectionId ?? null,
    destinations: { company: dest.companyHome, departments: dest.departments, teams: dest.teams },
    preferences,
    visibilityOptions: ["company", "department", "team", "restricted"] as const,
    defaultVisibility: "company",
    capabilities: {
      canCreateBriefs: true,
      canPublishOwnBriefs: true,
      canManageStructure: admin,
      canManageMemberships: admin,
      canCreateConnectionToken: ctx.via !== "mcp",
    },
  };
}

/** Company, permitted destinations, preferences and capabilities for authoring. Members only. */
export const getAuthoringContext = (db: Database, ctx: RequestContext) => withCtx(db, ctx, (tx, c) => getAuthoringContextInTx(tx, c));

// ---------------------------------------------------------------------------
// Destination resolution
// ---------------------------------------------------------------------------

export type DestinationNoneReason =
  /** No text, ids or usable remembered default. */
  | "no_default"
  /** Text matched nothing. */
  | "no_match"
  /** Id unknown in this company (including ids from another company). */
  | "not_found"
  /** Exists, but the user may not publish there. */
  | "not_authorized"
  | "archived"
  /** Department and team ids do not belong together. */
  | "mismatch";

export type DestinationResolution =
  | { status: "resolved"; home: DestinationHome; source: "id" | "text" | "preference" }
  | { status: "ambiguous"; candidates: DestinationHome[] }
  | { status: "none"; reason: DestinationNoneReason; message: string };

const ResolveDestinationInput = z.object({
  text: z.string().trim().max(500).optional(),
  departmentId: z.string().trim().max(100).optional(),
  teamId: z.string().trim().max(100).optional(),
});

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "in", "into", "on", "of", "our", "my", "this", "that", "it", "send", "publish", "post",
  "share", "put", "place", "brief", "briefing", "cerebro", "please", "make", "visible", "under", "at", "with", "and",
  "group", "folks", "home", "space", "workspace", "s",
]);
const TEAM_HINTS = new Set(["team", "teams", "squad"]);
const DEPT_HINTS = new Set(["department", "departments", "dept", "depts", "division", "function"]);
const COMPANY_WORDS = new Set(["company", "companywide", "wide", "whole", "entire", "everyone", "everybody", "all", "hands", "org", "orgwide", "organization", "organisation", "global"]);
const COMPANY_PHRASES = [/\bcompany[\s-]?wide\b/, /\b(whole|entire|all of( the)?) (company|org|organi[sz]ation)\b/, /\beveryone\b/, /\ball[\s-]hands\b/, /\borg(ani[sz]ation)?[\s-]?wide\b/, /^\s*(the\s+)?(company|org|organi[sz]ation)\s*$/];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const fuzzyEq = (q: string, c: string): boolean =>
  q === c ||
  (q.length >= 3 && c.startsWith(q)) ||
  (c.length >= 3 && q.startsWith(c)) ||
  (Math.min(q.length, c.length) >= 4 && levenshtein(q, c) <= (Math.min(q.length, c.length) >= 8 ? 2 : 1));

/** Score how well query tokens match a node name (+ slug). 0 = no match. */
function scoreName(query: Set<string>, nameTokens: string[]): number {
  const toks = nameTokens.filter((t) => !STOPWORDS.has(t));
  if (toks.length === 0) return 0;
  const exact = toks.filter((t) => query.has(t)).length;
  if (exact === toks.length) return 3;
  const fuzzy = toks.filter((t) => [...query].some((q) => fuzzyEq(q, t))).length;
  if (fuzzy === toks.length) return 2;
  if (exact > 0 || fuzzy > 0) return 1;
  return 0;
}

function matchText(text: string, company: Company, dest: AuthorizedDestinations): DestinationHome[] | "company" | null {
  const lower = text.toLowerCase();
  const all = words(text);
  const wantsTeam = all.some((w) => TEAM_HINTS.has(w));
  const wantsDept = all.some((w) => DEPT_HINTS.has(w));
  const companyTokens = new Set([...words(company.name), ...words(company.slug)]);
  const query = new Set(
    all.filter((w) => !STOPWORDS.has(w) && !TEAM_HINTS.has(w) && !DEPT_HINTS.has(w) && !COMPANY_WORDS.has(w) && !companyTokens.has(w)),
  );

  if (query.size > 0) {
    type Scored = { home: DestinationHome; score: number };
    const scored: Scored[] = [];
    if (!wantsTeam || wantsDept) {
      for (const d of dest.departments) {
        const s = scoreName(query, [...words(d.departmentName!), ...words(d.departmentSlug!)]);
        if (s > 0) scored.push({ home: d, score: s + (wantsDept && !wantsTeam ? 0.25 : 0) });
      }
    }
    if (!wantsDept || wantsTeam) {
      for (const t of dest.teams) {
        const s = scoreName(query, [...words(t.teamName!), ...words(t.teamSlug!)]);
        if (s === 0) continue;
        // Naming the parent department disambiguates teams with the same name.
        const deptTokens = words(t.departmentName!).filter((w) => !STOPWORDS.has(w));
        const deptBonus = deptTokens.length > 0 && deptTokens.every((w) => query.has(w)) ? 0.5 : 0;
        scored.push({ home: t, score: s + deptBonus + (wantsTeam && !wantsDept ? 0.25 : 0) });
      }
    }
    if (scored.length > 0) {
      const best = Math.max(...scored.map((s) => s.score));
      return scored.filter((s) => s.score === best).map((s) => s.home);
    }
    if (COMPANY_PHRASES.some((re) => re.test(lower))) return "company";
    return null;
  }
  if (COMPANY_PHRASES.some((re) => re.test(lower)) || all.some((w) => companyTokens.has(w) || w === "company")) return "company";
  return null;
}

export async function resolveDestinationInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: { text?: string; departmentId?: string; teamId?: string },
): Promise<DestinationResolution> {
  const input = parseInput(ResolveDestinationInput, rawInput);
  const dest = await listAuthorizedDestinationsInTx(tx, ctx);
  const none = (reason: DestinationNoneReason, message: string): DestinationResolution => ({ status: "none", reason, message });

  if (input.teamId || input.departmentId) {
    // Untrusted ids: resolve only inside the context company.
    if (input.teamId) {
      const team = Uuid.safeParse(input.teamId).success ? await findTeam(tx, ctx, input.teamId) : null;
      if (!team) return none("not_found", "That team was not found in this company.");
      if (input.departmentId && input.departmentId !== team.departmentId) {
        return none("mismatch", "That team does not belong to the given department.");
      }
      const dept = await findDepartment(tx, ctx, team.departmentId);
      if (team.archivedAt || dept?.archivedAt) return none("archived", "That team is archived.");
      const home = dest.teams.find((t) => t.teamId === team.id);
      if (!home) return none("not_authorized", "You can only publish into teams you belong to.");
      return { status: "resolved", home, source: "id" };
    }
    const d = Uuid.safeParse(input.departmentId).success ? await findDepartment(tx, ctx, input.departmentId!) : null;
    if (!d) return none("not_found", "That department was not found in this company.");
    if (d.archivedAt) return none("archived", "That department is archived.");
    const home = dest.departments.find((x) => x.departmentId === d.id);
    if (!home) return none("not_authorized", "You can only publish into departments you belong to.");
    return { status: "resolved", home, source: "id" };
  }

  if (input.text) {
    const match = matchText(input.text, dest.company, dest);
    if (match === "company") return { status: "resolved", home: dest.companyHome, source: "text" };
    if (match && match.length === 1) return { status: "resolved", home: match[0]!, source: "text" };
    if (match && match.length > 1) return { status: "ambiguous", candidates: match };
    // Distinguish "exists but not yours" from "no such destination" for a useful question.
    const allNodes = await tx.execute<{ name: string; slug: string }>(sql`
      select name, slug from teams where organization_id = ${ctx.organizationId}::uuid and archived_at is null
      union all
      select name, slug from departments where organization_id = ${ctx.organizationId}::uuid and archived_at is null`);
    const query = new Set(words(input.text).filter((w) => !STOPWORDS.has(w) && !TEAM_HINTS.has(w) && !DEPT_HINTS.has(w)));
    const exists = allNodes.rows.some((n) => scoreName(query, [...words(n.name), ...words(n.slug)]) >= 2);
    return exists
      ? none("not_authorized", "That destination exists, but you can only publish into teams and departments you belong to.")
      : none("no_match", "No matching company, department or team destination.");
  }

  const prefs = await getAuthoringPreferencesInTx(tx, ctx);
  if (prefs.defaultHome) return { status: "resolved", home: prefs.defaultHome, source: "preference" };
  return none("no_default", "Choose a destination: the company, one of your departments or one of your teams.");
}

/**
 * Resolve a requested home from natural language ("Platform team", "the
 * Finance department", "company-wide") or untrusted ids, within ctx's company
 * only. Falls back to the remembered default when neither is given.
 */
export const resolveDestination = (db: Database, ctx: RequestContext, input: { text?: string; departmentId?: string; teamId?: string }) =>
  withCtx(db, ctx, (tx, c) => resolveDestinationInTx(tx, c, input));

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------

export interface AudienceReader {
  userId: string;
  email: string;
  displayName: string;
  /** Active company member (false: external reader with an existing account). */
  isMember: boolean;
}

export interface AudienceResolution {
  /**
   * Validated audience in the shape of the briefings module's `AudienceSpec`
   * input (`createBriefing` / `changeAudience`), ready to pass through.
   */
  audience: {
    visibility: "company" | "department" | "team" | "restricted";
    departmentId: string | null;
    teamId: string | null;
    readerUserIds: string[];
  };
  visibility: "company" | "department" | "team" | "restricted";
  departmentId: string | null;
  teamId: string | null;
  /** e.g. "Everyone at Acme", "Product department", "Platform team", "Named readers only". */
  label: string;
  /** Named readers who will receive reader grants. */
  readers: AudienceReader[];
  /** Emails without a visible Cerebro account: become invitations at publication. */
  invitations: { email: string }[];
}

const ResolveAudienceSchema = z.object({
  visibility: z.enum(["company", "department", "team", "restricted"]),
  departmentId: z.string().trim().max(100).nullish(),
  teamId: z.string().trim().max(100).nullish(),
  readerEmails: z.array(z.string().trim().email().max(320)).max(200).default([]),
});

export interface ResolveAudienceInput {
  visibility: "company" | "department" | "team" | "restricted";
  departmentId?: string | null;
  teamId?: string | null;
  readerEmails?: string[];
}

export async function resolveAudienceInTx(tx: Tx, ctx: RequestContext, rawInput: ResolveAudienceInput): Promise<AudienceResolution> {
  const input = parseInput(ResolveAudienceSchema, rawInput);
  await requireMember(tx, ctx);
  const company = await loadCompany(tx, ctx);
  let departmentId: string | null = null;
  let teamId: string | null = null;
  let label: string;

  switch (input.visibility) {
    case "company":
    case "restricted":
      if (input.departmentId || input.teamId) {
        throw new DomainError("validation", `A ${input.visibility} audience does not take a department or team.`);
      }
      label = input.visibility === "company" ? `Everyone at ${company.name}` : "Named readers only";
      break;
    case "department": {
      if (input.teamId) throw new DomainError("validation", "A department audience does not take a team.");
      if (!input.departmentId) throw new DomainError("validation", "A department audience needs a department.");
      const d = Uuid.safeParse(input.departmentId).success ? await findDepartment(tx, ctx, input.departmentId) : null;
      if (!d) throw new DomainError("not_found", "Department not found.");
      if (d.archivedAt) throw new DomainError("conflict", "Department is archived.", { reason: "archived" });
      departmentId = d.id;
      label = `${d.name} department`;
      break;
    }
    case "team": {
      if (input.departmentId) throw new DomainError("validation", "A team audience does not take a department.");
      if (!input.teamId) throw new DomainError("validation", "A team audience needs a team.");
      const t = Uuid.safeParse(input.teamId).success ? await findTeam(tx, ctx, input.teamId) : null;
      if (!t) throw new DomainError("not_found", "Team not found.");
      if (t.archivedAt) throw new DomainError("conflict", "Team is archived.", { reason: "archived" });
      teamId = t.id;
      label = `${t.name} team`;
      break;
    }
  }

  const emails = [...new Set(input.readerEmails.map(normalizeEmail))];
  if (input.visibility === "restricted" && emails.length === 0) {
    throw new DomainError("validation", "A restricted audience needs at least one named reader.");
  }
  const readers: AudienceReader[] = [];
  const invitations: { email: string }[] = [];
  if (emails.length > 0) {
    // RLS shows only users connected to this company (members, grant holders,
    // self). Anyone else is treated as an invitation intent; acceptance binds
    // to the verified email.
    const res = await tx.execute<{ id: string; email: string; display_name: string; is_member: boolean }>(sql`
      select u.id, u.email, u.display_name,
        exists (select 1 from memberships m where m.organization_id = ${ctx.organizationId}::uuid
                  and m.user_id = u.id and m.status = 'active') as is_member
      from users u
      where lower(u.email) in (${sql.join(
        emails.map((e) => sql`${e}`),
        sql`, `,
      )})`);
    const byEmail = new Map(res.rows.map((r) => [normalizeEmail(r.email), r]));
    for (const email of emails) {
      const u = byEmail.get(email);
      if (u) readers.push({ userId: u.id, email, displayName: u.display_name, isMember: u.is_member });
      else invitations.push({ email });
    }
  }
  return {
    audience: { visibility: input.visibility, departmentId, teamId, readerUserIds: readers.map((r) => r.userId) },
    visibility: input.visibility,
    departmentId,
    teamId,
    label,
    readers,
    invitations,
  };
}

/** Validate an audience inside ctx's company and resolve named readers. */
export const resolveAudience = (db: Database, ctx: RequestContext, input: ResolveAudienceInput) =>
  withCtx(db, ctx, (tx, c) => resolveAudienceInTx(tx, c, input));
