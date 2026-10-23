import type { Metadata } from "next";
import { getFeaturedBriefing, getOrgTree, getPeople, listLibrary } from "@cerebro/domain";
import { FeaturedBriefing } from "@/components/library/featured-briefing";
import { LibraryFilters } from "@/components/library/filters";
import { LibraryResults, NewBriefButton, nextPageHref } from "@/components/library/library-results";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { filterOptions, readLibraryParams, resolveScope, SORTS, toRowData, validAuthor } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ company: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { company } = await params;
  const ws = await getRequestContext(company);
  return { title: `All briefs · ${ws.org.name}` };
}

/** Company home: All briefs, featured briefing, filters and search. */
export default async function CompanyLibraryPage({ params, searchParams }: Props) {
  const { company } = await params;
  const sp = readLibraryParams(await searchParams);
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;

  const [tree, people] = await Promise.all([
    loadOrThrow(() => getOrgTree(ws.db, ws.ctx)),
    loadOrThrow(() => getPeople(ws.db, ws.ctx)),
  ]);
  const resolved = resolveScope(tree, sp);
  const authorId = validAuthor(sp.author);
  const invalid = resolved.invalid || (sp.author !== undefined && !authorId);
  const filtered = Boolean(sp.q || resolved.scope.kind !== "company" || sp.author || invalid);

  const page = invalid
    ? { items: [], total: 0, nextCursor: null }
    : await loadOrThrow(() =>
        listLibrary(ws.db, ws.ctx, {
          scope: resolved.scope,
          authorId,
          q: sp.q,
          sort: sp.sort === "title" ? "title" : "recent",
          cursor: sp.cursor ?? null,
        }),
      );
  const featured = filtered || sp.cursor ? null : await loadOrThrow(() => getFeaturedBriefing(ws.db, ws.ctx));
  const rows = page.items.filter((r) => r.briefingId !== featured?.briefingId).map(toRowData);
  const { departments, teams, authors } = filterOptions(tree, people);

  const scopeLabel = resolved.teamName
    ? `In ${resolved.departmentName} / ${resolved.teamName}`
    : resolved.departmentName
      ? `In ${resolved.departmentName}`
      : sp.q
        ? `Results for “${sp.q}”`
        : "Across the company";

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / Company workspace`}
        title="A shared view of what’s next."
        description={`The latest thinking, decisions, and plans from across ${ws.org.name}.`}
        actions={<NewBriefButton href={paths.newBrief(slug)} />}
      />
      <LibraryFilters
        action={paths.company(slug)}
        values={sp}
        departments={departments}
        teams={teams}
        authors={authors}
        sorts={SORTS}
      />
      {featured ? <FeaturedBriefing companySlug={slug} briefing={toRowData(featured)} tag="Company brief" /> : null}
      <LibraryResults
        companySlug={slug}
        headingId="library-heading"
        heading={scopeLabel}
        rows={rows}
        total={page.total}
        filtered={filtered}
        nextHref={nextPageHref(paths.company(slug), { q: sp.q, department: sp.department, team: sp.team, author: sp.author, sort: sp.sort }, page.nextCursor)}
        emptyTitle="No published briefs yet"
        emptyDescription={`When colleagues publish briefs visible to you, they appear here. Start one from your connected LLM or create a new brief.`}
        emptyAction={<NewBriefButton href={paths.newBrief(slug)} label="Create the first brief" />}
      />
    </PageContainer>
  );
}
