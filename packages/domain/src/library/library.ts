/**
 * Shared discovery (TEAM_WORKSPACES.md): company, department and team views,
 * author filter, search, featured brief and My drafts.
 *
 * Every published row, count and search match is filtered with
 * `readablePublishedBriefingsCondition`, the same predicate behind reader
 * access, and archived briefings are excluded. Titles and summaries come from
 * the published revision document, never from the draft. External readers
 * (no active membership) cannot browse: lists throw `not_found`, search and
 * featured return nothing.
 */
import { briefings, type Database, type Tx } from "@cerebro/database";
import { getMembership, readablePublishedBriefingsCondition, resolveBriefingAccess, type BriefingRole } from "../access/index";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { findDepartment, findTeam } from "../org/structure";
import { likePattern, parseInput, requireMember, toDate, Uuid, withCtx } from "../org/shared";

export type LibraryVisibility = "company" | "department" | "team" | "restricted";

export interface LibraryOrgRef {
  id: string;
  name: string;
  slug: string;
}

export interface LibraryHome {
  /** Null for company-home briefs. */
  department: LibraryOrgRef | null;
  team: LibraryOrgRef | null;
}

export interface LibraryRow {
  briefingId: string;
  slug: string;
  /** Published revision title. */
  title: string;
  /** Published `position.headline`. */
  headline: string | null;
  /** Published `position.summary`, truncated for list display. */
  summary: string | null;
  author: { id: string; name: string };
  home: LibraryHome;
  visibility: LibraryVisibility;
  /** e.g. "Company", "Product department", "Platform team", "Restricted". */
  visibilityLabel: string;
  /** Number of the current published revision. */
  revisionNumber: number;
  /** First (non-withdrawn) publication time. */
  publishedAt: Date;
  /** Current publication time (latest released version). */
  updatedAt: Date;
  /**
   * Per-user reading state from the viewer's own private `briefing_reads`
   * record (never engagement events, never visible to authors).
   * `isUnread`: the viewer has never opened this briefing (false for their own briefs).
   * `hasNewVersion`: the viewer opened an earlier revision than the current one.
   */
  isUnread?: boolean;
  hasNewVersion?: boolean;
}

export type LibraryScope = { kind: "company" } | { kind: "department"; departmentId: string } | { kind: "team"; teamId: string };

export interface ListLibraryInput {
  scope?: LibraryScope;
  authorId?: string;
  q?: string;
  sort?: "recent" | "title";
  limit?: number;
  cursor?: string | null;
}

export interface LibraryPage {
  items: LibraryRow[];
  /** Permission-filtered total for the scope and filters. */
  total: number;
  nextCursor: string | null;
  /** Team scope only: department- and company-home briefs, most recent first, labelled separately. */
  parentAnnouncements?: LibraryRow[];
}

const SUMMARY_MAX = 280;
const PARENT_ANNOUNCEMENTS = 5;

const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company") }),
  z.object({ kind: z.literal("department"), departmentId: Uuid }),
  z.object({ kind: z.literal("team"), teamId: Uuid }),
]);

const ListLibrarySchema = z.object({
  scope: ScopeSchema.default({ kind: "company" }),
  authorId: Uuid.optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["recent", "title"]).default("recent"),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).nullish(),
});

// ---------------------------------------------------------------------------
// SQL building blocks (outer table is the unaliased `briefings`)
// ---------------------------------------------------------------------------

const FROM = sql`
  from ${briefings}
  join publications p on p.organization_id = ${briefings.organizationId} and p.id = ${briefings.currentPublicationId}
  join briefing_revisions r on r.organization_id = p.organization_id and r.id = p.revision_id
  join users u on u.id = ${briefings.ownerId}
  left join departments hd on hd.organization_id = ${briefings.organizationId} and hd.id = ${briefings.homeDepartmentId}
  left join teams ht on ht.organization_id = ${briefings.organizationId} and ht.id = ${briefings.homeTeamId}
  left join departments aud on aud.organization_id = ${briefings.organizationId} and aud.id = ${briefings.audienceDepartmentId}
  left join teams aut on aut.organization_id = ${briefings.organizationId} and aut.id = ${briefings.audienceTeamId}`;

const TITLE = sql`coalesce(r.document_json->>'title', ${briefings.title})`;
const HEADLINE = sql`(r.document_json->'position'->>'headline')`;
const SUMMARY = sql`(r.document_json->'position'->>'summary')`;

const SELECT = sql`
  select ${briefings.id} as id, ${briefings.slug} as slug, ${TITLE} as title,
    ${HEADLINE} as headline, ${SUMMARY} as summary, ${briefings.visibility} as visibility,
    r.number as revision_number, p.published_at as updated_at,
    (select min(p2.published_at) from publications p2
      where p2.organization_id = ${briefings.organizationId} and p2.briefing_id = ${briefings.id}
        and p2.withdrawn_at is null) as first_published_at,
    u.id as owner_id, u.display_name as owner_name,
    hd.id as hd_id, hd.name as hd_name, hd.slug as hd_slug,
    ht.id as ht_id, ht.name as ht_name, ht.slug as ht_slug,
    aud.name as ad_name, aut.name as at_name,
    (select br.last_revision_number from briefing_reads br
      where br.organization_id = ${briefings.organizationId} and br.briefing_id = ${briefings.id}
        and br.user_id = app_current_user()) as read_revision_number,
    (${briefings.ownerId} = app_current_user()) as is_owner`;

interface Row extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  headline: string | null;
  summary: string | null;
  visibility: LibraryVisibility;
  revision_number: number;
  updated_at: unknown;
  first_published_at: unknown;
  owner_id: string;
  owner_name: string;
  hd_id: string | null;
  hd_name: string | null;
  hd_slug: string | null;
  ht_id: string | null;
  ht_name: string | null;
  ht_slug: string | null;
  ad_name: string | null;
  at_name: string | null;
  read_revision_number: number | null;
  is_owner: boolean | null;
}

const truncate = (s: string | null, n: number): string | null => {
  if (s === null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

export function libraryVisibilityLabel(visibility: LibraryVisibility, audienceDepartmentName?: string | null, audienceTeamName?: string | null): string {
  switch (visibility) {
    case "company":
      return "Company";
    case "department":
      return audienceDepartmentName ? `${audienceDepartmentName} department` : "Department";
    case "team":
      return audienceTeamName ? `${audienceTeamName} team` : "Team";
    case "restricted":
      return "Restricted";
  }
}

function toRow(r: Row): LibraryRow {
  const updatedAt = toDate(r.updated_at);
  const revisionNumber = Number(r.revision_number);
  // RLS limits briefing_reads to the viewer's own rows; the subquery adds no other filter.
  const readRevision = r.read_revision_number === null || r.read_revision_number === undefined ? null : Number(r.read_revision_number);
  const own = r.is_owner === true;
  return {
    briefingId: r.id,
    slug: r.slug,
    title: r.title,
    headline: r.headline,
    summary: truncate(r.summary, SUMMARY_MAX),
    author: { id: r.owner_id, name: r.owner_name },
    home: {
      department: r.hd_id ? { id: r.hd_id, name: r.hd_name!, slug: r.hd_slug! } : null,
      team: r.ht_id ? { id: r.ht_id, name: r.ht_name!, slug: r.ht_slug! } : null,
    },
    visibility: r.visibility,
    visibilityLabel: libraryVisibilityLabel(r.visibility, r.ad_name, r.at_name),
    revisionNumber,
    publishedAt: r.first_published_at ? toDate(r.first_published_at) : updatedAt,
    updatedAt,
    isUnread: !own && readRevision === null,
    hasNewVersion: !own && readRevision !== null && readRevision < revisionNumber,
  };
}

/** Readable, published, not archived: the base of every library query. */
const readable = (ctx: RequestContext): SQL =>
  sql`${readablePublishedBriefingsCondition(ctx)} and ${briefings.archivedAt} is null`;

function searchCondition(q: string): SQL {
  const like = likePattern(q);
  return sql`(
    ${TITLE} ilike ${like} escape '\\'
    or coalesce(${HEADLINE}, '') ilike ${like} escape '\\'
    or coalesce(${SUMMARY}, '') ilike ${like} escape '\\'
    or u.display_name ilike ${like} escape '\\'
    or coalesce(hd.name, '') ilike ${like} escape '\\'
    or coalesce(ht.name, '') ilike ${like} escape '\\'
    or to_tsvector('english', ${TITLE} || ' ' || coalesce(${HEADLINE}, '') || ' ' || coalesce(${SUMMARY}, ''))
       @@ websearch_to_tsquery('english', ${q}))`;
}

const ORDER = {
  recent: sql`order by p.published_at desc, ${briefings.id} desc`,
  title: sql`order by lower(${TITLE}) asc, ${briefings.id} asc`,
} as const;

async function selectRows(tx: Tx, where: SQL, order: SQL, limit: number, offset: number): Promise<LibraryRow[]> {
  const res = await tx.execute<Row>(sql`${SELECT} ${FROM} where ${where} ${order} limit ${limit} offset ${offset}`);
  return res.rows.map(toRow);
}

async function countRows(tx: Tx, where: SQL): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`select count(*)::int as n ${FROM} where ${where}`);
  return Number(res.rows[0]?.n ?? 0);
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= 100_000) return o;
  } catch {
    // fall through
  }
  throw new DomainError("validation", "Invalid cursor.");
}

// ---------------------------------------------------------------------------
// Library views
// ---------------------------------------------------------------------------

export async function listLibraryInTx(tx: Tx, ctx: RequestContext, rawInput: ListLibraryInput = {}): Promise<LibraryPage> {
  const input = parseInput(ListLibrarySchema, rawInput);
  await requireMember(tx, ctx);
  const offset = decodeCursor(input.cursor);

  const conds: SQL[] = [readable(ctx)];
  let teamDepartmentId: string | null = null;
  if (input.scope.kind === "department") {
    if (!(await findDepartment(tx, ctx, input.scope.departmentId))) throw new DomainError("not_found", "Department not found.");
    // Team-homed briefs carry their team's department as home department.
    conds.push(sql`${briefings.homeDepartmentId} = ${input.scope.departmentId}::uuid`);
  } else if (input.scope.kind === "team") {
    const team = await findTeam(tx, ctx, input.scope.teamId);
    if (!team) throw new DomainError("not_found", "Team not found.");
    teamDepartmentId = team.departmentId;
    conds.push(sql`${briefings.homeTeamId} = ${input.scope.teamId}::uuid`);
  }
  if (input.authorId) conds.push(sql`${briefings.ownerId} = ${input.authorId}::uuid`);
  if (input.q) conds.push(searchCondition(input.q));
  const where = sql.join(conds, sql` and `);

  const [items, total] = [
    await selectRows(tx, where, ORDER[input.sort], input.limit + 1, offset),
    await countRows(tx, where),
  ];
  const hasMore = items.length > input.limit;
  const page: LibraryPage = {
    items: items.slice(0, input.limit),
    total,
    nextCursor: hasMore ? encodeCursor(offset + input.limit) : null,
  };

  if (teamDepartmentId) {
    const parentWhere = sql`${readable(ctx)} and ${briefings.homeTeamId} is null
      and (${briefings.homeDepartmentId} is null or ${briefings.homeDepartmentId} = ${teamDepartmentId}::uuid)`;
    page.parentAnnouncements = await selectRows(tx, parentWhere, ORDER.recent, PARENT_ANNOUNCEMENTS, 0);
  }
  return page;
}

/** Company / department / team library page. Members only (`not_found` otherwise). */
export const listLibrary = (db: Database, ctx: RequestContext, input: ListLibraryInput = {}) =>
  withCtx(db, ctx, (tx, c) => listLibraryInTx(tx, c, input));

const SearchSchema = z.object({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) });

export async function searchBriefingsInTx(
  tx: Tx,
  ctx: RequestContext,
  input: string | { q: string; limit?: number },
): Promise<{ items: LibraryRow[]; total: number }> {
  const { q, limit } = parseInput(SearchSchema, typeof input === "string" ? { q: input } : input);
  if (!(await getMembership(tx, ctx))) return { items: [], total: 0 };
  const where = sql`${readable(ctx)} and ${searchCondition(q)}`;
  return { items: await selectRows(tx, where, ORDER.recent, limit, 0), total: await countRows(tx, where) };
}

/** Search accessible published briefs by title, position text, author and home names. Non-members get nothing. */
export const searchBriefings = (db: Database, ctx: RequestContext, input: string | { q: string; limit?: number }) =>
  withCtx(db, ctx, (tx, c) => searchBriefingsInTx(tx, c, input));

export async function getFeaturedBriefingInTx(tx: Tx, ctx: RequestContext): Promise<LibraryRow | null> {
  if (!(await getMembership(tx, ctx))) return null;
  const where = sql`${readable(ctx)} and ${briefings.visibility} = 'company' and ${briefings.homeDepartmentId} is null`;
  return (await selectRows(tx, where, ORDER.recent, 1, 0))[0] ?? null;
}

/** Most recent company-home, company-visible brief, or null. */
export const getFeaturedBriefing = (db: Database, ctx: RequestContext) => withCtx(db, ctx, (tx, c) => getFeaturedBriefingInTx(tx, c));

// ---------------------------------------------------------------------------
// My drafts
// ---------------------------------------------------------------------------

export interface DraftRow {
  briefingId: string;
  slug: string;
  /** Draft document title (visible only to collaborators). */
  title: string;
  lockVersion: number;
  draftUpdatedAt: Date;
  roles: BriefingRole[];
  home: LibraryHome;
  /** Number of the current published revision, if any. */
  currentRevisionNumber: number | null;
}

interface DraftDbRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  lock_version: number;
  draft_updated_at: unknown;
  current_revision_number: number | null;
  hd_id: string | null;
  hd_name: string | null;
  hd_slug: string | null;
  ht_id: string | null;
  ht_name: string | null;
  ht_slug: string | null;
}

export async function listMyDraftsInTx(tx: Tx, ctx: RequestContext): Promise<DraftRow[]> {
  if (!(await getMembership(tx, ctx))) return [];
  // Candidate rows by ownership or collaborator grant; the access policy then
  // decides (`view_draft`), so this list cannot disagree with the editor.
  const res = await tx.execute<DraftDbRow>(sql`
    select ${briefings.id} as id, ${briefings.slug} as slug,
      coalesce(d.document_json->>'title', ${briefings.title}) as title,
      d.lock_version, d.updated_at as draft_updated_at,
      (select r.number from publications p join briefing_revisions r on r.organization_id = p.organization_id and r.id = p.revision_id
        where p.organization_id = ${briefings.organizationId} and p.id = ${briefings.currentPublicationId}
          and p.withdrawn_at is null) as current_revision_number,
      hd.id as hd_id, hd.name as hd_name, hd.slug as hd_slug,
      ht.id as ht_id, ht.name as ht_name, ht.slug as ht_slug
    from ${briefings}
    join briefing_drafts d on d.organization_id = ${briefings.organizationId} and d.briefing_id = ${briefings.id}
    left join departments hd on hd.organization_id = ${briefings.organizationId} and hd.id = ${briefings.homeDepartmentId}
    left join teams ht on ht.organization_id = ${briefings.organizationId} and ht.id = ${briefings.homeTeamId}
    where ${briefings.organizationId} = ${ctx.organizationId}::uuid
      and ${briefings.archivedAt} is null
      and (${briefings.ownerId} = ${ctx.userId}::uuid or exists (
        select 1 from briefing_grants g
        where g.organization_id = ${briefings.organizationId} and g.briefing_id = ${briefings.id}
          and g.user_id = ${ctx.userId}::uuid and g.revoked_at is null
          and g.role in ('owner', 'editor', 'publisher')))
    order by d.updated_at desc, ${briefings.id}`);
  const out: DraftRow[] = [];
  for (const r of res.rows) {
    const access = await resolveBriefingAccess(tx, ctx, r.id);
    if (!access?.capabilities.has("view_draft")) continue;
    out.push({
      briefingId: r.id,
      slug: r.slug,
      title: r.title,
      lockVersion: Number(r.lock_version),
      draftUpdatedAt: toDate(r.draft_updated_at),
      roles: access.roles,
      home: {
        department: r.hd_id ? { id: r.hd_id, name: r.hd_name!, slug: r.hd_slug! } : null,
        team: r.ht_id ? { id: r.ht_id, name: r.ht_name!, slug: r.ht_slug! } : null,
      },
      currentRevisionNumber: r.current_revision_number === null ? null : Number(r.current_revision_number),
    });
  }
  return out;
}

/** Briefings with a draft where the user is owner, editor or publisher. */
export const listMyDrafts = (db: Database, ctx: RequestContext) => withCtx(db, ctx, (tx, c) => listMyDraftsInTx(tx, c));
