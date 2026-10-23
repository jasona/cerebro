import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPeople, listLibrary, type PersonDTO } from "@cerebro/domain";
import { LibraryFilters } from "@/components/library/filters";
import { LibraryResults, nextPageHref } from "@/components/library/library-results";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { Avatar } from "@/components/workspace/top-bar";
import { getRequestContext, type WorkspaceContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { readLibraryParams, SORTS, toRowData, validAuthor } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ company: string; userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function findPerson(ws: WorkspaceContext, userId: string): Promise<PersonDTO> {
  const id = validAuthor(userId);
  if (!id) notFound();
  // The directory lists active members only; anyone else is not found.
  const person = (await loadOrThrow(() => getPeople(ws.db, ws.ctx))).find((p) => p.userId === id);
  if (!person) notFound();
  return person;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { company, userId } = await params;
  const ws = await getRequestContext(company);
  const person = await findPerson(ws, userId);
  return { title: `${person.displayName} · People` };
}

/** Author view: a colleague's briefs that are visible to the viewer (not a copy). */
export default async function PersonPage({ params, searchParams }: Props) {
  const { company, userId } = await params;
  const sp = readLibraryParams(await searchParams);
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const person = await findPerson(ws, userId);
  const page = await loadOrThrow(() =>
    listLibrary(ws.db, ws.ctx, { authorId: person.userId, q: sp.q, sort: sp.sort === "title" ? "title" : "recent", cursor: sp.cursor ?? null }),
  );
  const affiliations = [
    ...person.teams.map((t) => `${t.departmentName} / ${t.name}`),
    ...person.departments.map((d) => d.name),
  ];
  const base = paths.person(slug, person.userId);
  const self = person.userId === ws.user.userId;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / People`}
        title={
          <span className="flex items-center gap-4">
            <Avatar name={person.displayName} />
            {person.displayName}
          </span>
        }
        size="headline"
        description={affiliations.length ? affiliations.join(" · ") : "No team memberships"}
      />
      <LibraryFilters action={base} values={sp} sorts={SORTS} />
      <LibraryResults
        companySlug={slug}
        headingId="person-heading"
        heading={sp.q ? `Results for “${sp.q}”` : self ? "Your published briefs" : `Briefs by ${person.displayName}`}
        rows={page.items.map(toRowData)}
        total={page.total}
        filtered={Boolean(sp.q)}
        nextHref={nextPageHref(base, { q: sp.q, sort: sp.sort }, page.nextCursor)}
        emptyTitle={self ? "You haven’t published a brief yet" : `No briefs by ${person.displayName} are visible to you`}
        emptyDescription={
          self
            ? "Your drafts are in My drafts until you publish them."
            : "They may not have published yet, or their briefs may be restricted to audiences you are not part of."
        }
      />
    </PageContainer>
  );
}
