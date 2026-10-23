import type { Metadata } from "next";
import Link from "next/link";
import { getOrgTree, getPeople, listLibrary, resolveOrgPath } from "@cerebro/domain";
import { cn, focusRing } from "@cerebro/ui";
import { PeopleIcon } from "@/components/icons";
import { LibraryFilters } from "@/components/library/filters";
import { LibraryResults, NewBriefButton, nextPageHref } from "@/components/library/library-results";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { plural } from "@/lib/format";
import { filterOptions, readLibraryParams, resolveScope, SORTS, toRowData, validAuthor } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ company: string; department: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { company, department } = await params;
  const ws = await getRequestContext(company);
  const { department: d } = await loadOrThrow(() => resolveOrgPath(ws.db, ws.ctx, { departmentSlug: decodeURIComponent(department) }));
  return { title: `${d.name} · ${ws.org.name}` };
}

/** Department home: its own briefs plus its teams' briefs. */
export default async function DepartmentPage({ params, searchParams }: Props) {
  const { company, department } = await params;
  const sp = readLibraryParams(await searchParams);
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const { department: dept } = await loadOrThrow(() => resolveOrgPath(ws.db, ws.ctx, { departmentSlug: decodeURIComponent(department) }));

  const [tree, people] = await Promise.all([loadOrThrow(() => getOrgTree(ws.db, ws.ctx)), loadOrThrow(() => getPeople(ws.db, ws.ctx))]);
  const node = tree.departments.find((d) => d.id === dept.id);
  const teams = (node?.teams ?? []).filter((t) => !t.archivedAt);

  // Team filter narrows within this department only.
  const resolved = sp.team ? resolveScope(tree, { department: dept.slug, team: sp.team.split("/").pop() }) : { scope: { kind: "department" as const, departmentId: dept.id }, invalid: false };
  const authorId = validAuthor(sp.author);
  const invalid = resolved.invalid || (sp.author !== undefined && !authorId);
  const filtered = Boolean(sp.q || sp.team || sp.author || invalid);
  const page = invalid
    ? { items: [], total: 0, nextCursor: null }
    : await loadOrThrow(() =>
        listLibrary(ws.db, ws.ctx, { scope: resolved.scope, authorId, q: sp.q, sort: sp.sort === "title" ? "title" : "recent", cursor: sp.cursor ?? null }),
      );
  const opts = filterOptions({ ...tree, departments: node ? [node] : [] }, people);
  const base = paths.department(slug, dept.slug);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / Department${dept.archivedAt ? " · Archived" : ""}`}
        title={dept.name}
        description={`Briefs from ${dept.name} and its teams${node ? ` · ${plural(node.memberCount, "person", "people")}` : ""}.`}
        actions={dept.archivedAt ? undefined : <NewBriefButton href={paths.newBrief(slug, { department: dept.slug })} />}
      />
      {teams.length ? (
        <nav aria-label={`Teams in ${dept.name}`} className="mt-6">
          <ul className="flex flex-wrap gap-2">
            {teams.map((t) => (
              <li key={t.id}>
                <Link
                  href={paths.team(slug, dept.slug, t.slug)}
                  className={cn("inline-flex items-center gap-2 rounded-pill border border-line bg-surface px-3.5 py-1.5 text-sm hover:border-line-strong", focusRing)}
                >
                  <PeopleIcon size={16} className="text-muted" />
                  {t.name}
                  <span className="text-muted">· {t.memberCount}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <LibraryFilters action={base} values={sp} teams={opts.teams} authors={opts.authors} sorts={SORTS} />
      <LibraryResults
        companySlug={slug}
        headingId="dept-heading"
        heading={sp.q ? `Results for “${sp.q}”` : `In ${dept.name}`}
        rows={page.items.map(toRowData)}
        total={page.total}
        filtered={filtered}
        nextHref={nextPageHref(base, { q: sp.q, team: sp.team, author: sp.author, sort: sp.sort }, page.nextCursor)}
        emptyTitle={`No published briefs in ${dept.name} yet`}
        emptyDescription="Briefs homed in this department or its teams that are visible to you appear here."
        emptyAction={dept.archivedAt ? undefined : <NewBriefButton href={paths.newBrief(slug, { department: dept.slug })} label={`Write a ${dept.name} brief`} />}
      />
    </PageContainer>
  );
}
