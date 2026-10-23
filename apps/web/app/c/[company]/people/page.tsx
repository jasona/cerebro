import type { Metadata } from "next";
import Link from "next/link";
import { getPeople } from "@cerebro/domain";
import { Badge, cn, EmptyState, focusRing } from "@cerebro/ui";
import { PeopleIcon, SearchIcon } from "@/components/icons";
import { PageContainer, PageHeader, SectionHeading } from "@/components/library/page-header";
import { Avatar } from "@/components/workspace/top-bar";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { plural } from "@/lib/format";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "People" };

/** Company directory: active members and their teams. Members only. */
export default async function PeoplePage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ q?: string }> }) {
  const { company } = await params;
  const q = (await searchParams).q?.trim().slice(0, 200) || undefined;
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const people = await loadOrThrow(() => getPeople(ws.db, ws.ctx, { q }));

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / People`}
        title="People"
        size="headline"
        description="Find colleagues and the briefs of theirs that are visible to you."
      />
      <form role="search" action={paths.people(slug)} method="get" className="mt-8 flex max-w-lg gap-2">
        <div className="relative flex-1">
          <label htmlFor="people-q" className="sr-only">
            Search people by name
          </label>
          <SearchIcon size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
          <input
            id="people-q"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            placeholder="Search people by name…"
            className={cn("h-11 w-full rounded-md border border-line-strong bg-surface pr-3 pl-10 text-base", focusRing)}
          />
        </div>
        <button type="submit" className={cn("h-11 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-subtle", focusRing)}>
          Search
        </button>
      </form>
      <section aria-labelledby="people-heading">
        <SectionHeading id="people-heading" title={q ? `Matching “${q}”` : "Everyone"} meta={[plural(people.length, "person", "people")]} />
        {people.length === 0 ? (
          <EmptyState icon={<PeopleIcon size={28} />} title="No one found" description="Try another name." headingLevel={3} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {people.map((p) => (
              <li key={p.userId} className="relative flex items-start gap-3 rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
                <Avatar name={p.displayName} />
                <div className="min-w-0">
                  <h3 className="font-medium text-ink">
                    <Link href={paths.person(slug, p.userId)} className={cn("rounded-sm after:absolute after:inset-0", focusRing)}>
                      {p.displayName}
                    </Link>
                  </h3>
                  <p className="mt-0.5 text-sm text-muted">
                    {p.teams.length ? p.teams.map((t) => `${t.departmentName} / ${t.name}`).join(", ") : p.departments.map((d) => d.name).join(", ") || "No team"}
                  </p>
                  {p.role !== "member" ? (
                    <Badge tone="accent" className="mt-2 capitalize">
                      {p.role}
                    </Badge>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
