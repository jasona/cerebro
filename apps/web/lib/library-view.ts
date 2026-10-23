import "server-only";
import type { DraftRow, LibraryRow, LibraryScope, OrgTree, PersonDTO } from "@cerebro/domain";
import type { BriefingRowData } from "@/components/library/types";
import type { FilterGroup, FilterOption } from "@/components/library/filters";
import { paths } from "./paths";

/** Library DTO → row view model. */
export function toRowData(r: LibraryRow): BriefingRowData {
  const homePath = [r.home.department?.name, r.home.team?.name].filter((x): x is string => Boolean(x));
  return {
    slug: r.slug,
    title: r.title,
    summary: r.summary ?? r.headline,
    author: { userId: r.author.id, name: r.author.name },
    homePath,
    audienceLabel: r.visibilityLabel,
    version: r.revisionNumber,
    updatedAt: r.updatedAt,
    activityVerb: r.revisionNumber > 1 ? "Updated" : "Published",
    newVersion: r.hasNewVersion ?? false,
    unread: r.isUnread ?? false,
  };
}

/** Draft DTO → row view model; drafts open the editor. */
export function draftToRowData(company: string, d: DraftRow): BriefingRowData {
  return {
    slug: d.slug,
    title: d.title || "Untitled draft",
    summary:
      d.currentRevisionNumber !== null
        ? `Working draft. Version ${d.currentRevisionNumber} is published.`
        : "Not yet published.",
    homePath: [d.home.department?.name, d.home.team?.name].filter((x): x is string => Boolean(x)),
    audienceLabel: d.roles.length ? d.roles.map((r) => r[0]!.toUpperCase() + r.slice(1)).join(", ") : "Collaborator",
    version: d.currentRevisionNumber,
    updatedAt: d.draftUpdatedAt,
    activityVerb: "Edited",
    status: "draft",
    href: paths.briefingEdit(company, d.slug),
  };
}

export interface LibrarySearchParams {
  q?: string;
  department?: string;
  team?: string;
  author?: string;
  sort?: string;
  cursor?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function readLibraryParams(sp: Record<string, string | string[] | undefined>): LibrarySearchParams {
  return {
    q: str(sp.q)?.slice(0, 200),
    department: str(sp.department),
    team: str(sp.team),
    author: str(sp.author),
    sort: sp.sort === "title" ? "title" : undefined,
    cursor: str(sp.cursor),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve filter slugs against the org tree into a domain scope. `team`
 * accepts "department-slug/team-slug" (filter form values) or a bare team
 * slug together with `department`. Unknown slugs resolve to `invalid` so the
 * page can show an empty, honest result instead of silently widening.
 */
export function resolveScope(
  tree: OrgTree,
  p: Pick<LibrarySearchParams, "department" | "team">,
): { scope: LibraryScope; invalid: boolean; departmentName?: string; teamName?: string } {
  let deptSlug = p.department;
  let teamSlug = p.team;
  if (teamSlug?.includes("/")) [deptSlug, teamSlug] = teamSlug.split("/", 2) as [string, string];
  if (!deptSlug && !teamSlug) return { scope: { kind: "company" }, invalid: false };
  const dept = deptSlug ? tree.departments.find((d) => d.slug === deptSlug) : undefined;
  if (deptSlug && !dept) return { scope: { kind: "company" }, invalid: true };
  if (teamSlug) {
    const candidates = (dept ? [dept] : tree.departments).flatMap((d) => d.teams.filter((t) => t.slug === teamSlug).map((t) => ({ d, t })));
    const hit = candidates.length === 1 ? candidates[0] : undefined;
    if (!hit) return { scope: { kind: "company" }, invalid: true };
    return { scope: { kind: "team", teamId: hit.t.id }, invalid: false, departmentName: hit.d.name, teamName: hit.t.name };
  }
  return { scope: { kind: "department", departmentId: dept!.id }, invalid: false, departmentName: dept!.name };
}

export function validAuthor(author: string | undefined): string | undefined {
  return author && UUID.test(author) ? author : undefined;
}

export function filterOptions(tree: OrgTree, people: PersonDTO[]) {
  const live = tree.departments.filter((d) => !d.archivedAt);
  const departments: FilterOption[] = live.map((d) => ({ value: d.slug, label: d.name }));
  const teams: FilterGroup[] = live
    .filter((d) => d.teams.some((t) => !t.archivedAt))
    .map((d) => ({
      label: d.name,
      options: d.teams.filter((t) => !t.archivedAt).map((t) => ({ value: `${d.slug}/${t.slug}`, label: t.name })),
    }));
  const authors: FilterOption[] = people.map((p) => ({ value: p.userId, label: p.displayName }));
  return { departments, teams, authors };
}

export const SORTS: FilterOption[] = [
  { value: "recent", label: "Latest activity" },
  { value: "title", label: "Title A–Z" },
];
