import type { Metadata } from "next";
import Link from "next/link";
import { getPeople, listLibrary, resolveOrgPath } from "@cerebro/domain";
import { cn, focusRing } from "@cerebro/ui";
import { BriefingList } from "@/components/library/briefing-row";
import { LibraryFilters } from "@/components/library/filters";
import { LibraryResults, NewBriefButton, nextPageHref } from "@/components/library/library-results";
import { PageContainer, PageHeader, SectionHeading } from "@/components/library/page-header";
import { Avatar } from "@/components/workspace/top-bar";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { plural } from "@/lib/format";
import { readLibraryParams, SORTS, toRowData, validAuthor } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ company: string; department: string; team: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function resolve(p: Awaited<Props["params"]>) {
  const ws = await getRequestContext(p.company);
  const path = await loadOrThrow(() =>
    resolveOrgPath(ws.db, ws.ctx, { departmentSlug: decodeURIComponent(p.department), teamSlug: decodeURIComponent(p.team) }),
  );
  return { ws, department: path.department, team: path.team! };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ws, team } = await resolve(await params);
  return { title: `${team.name} · ${ws.org.name}` };
}

/** Team home: local briefs, then separately labelled parent announcements. */
export default async function TeamPage({ params, searchParams }: Props) {
  const { ws, department, team } = await resolve(await params);
  const sp = readLibraryParams(await searchParams);
  const slug = ws.org.slug;

  const members = await loadOrThrow(() => getPeople(ws.db, ws.ctx, { teamId: team.id }));
  const authorId = validAuthor(sp.author);
  const invalid = sp.author !== undefined && !authorId;
  const filtered = Boolean(sp.q || sp.author);
  const page = invalid
    ? { items: [], total: 0, nextCursor: null, parentAnnouncements: [] }
    : await loadOrThrow(() =>
        listLibrary(ws.db, ws.ctx, {
          scope: { kind: "team", teamId: team.id },
          authorId,
          q: sp.q,
          sort: sp.sort === "title" ? "title" : "recent",
          cursor: sp.cursor ?? null,
        }),
      );
  const base = paths.team(slug, department.slug, team.slug);
  const announcements = (page.parentAnnouncements ?? []).map(toRowData);
  const home = { department: department.slug, team: team.slug };

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <>
            <Link href={paths.department(slug, department.slug)} className={cn("rounded-sm hover:text-ink", focusRing)}>
              {department.name}
            </Link>{" "}
            / Team{team.archivedAt ? " · Archived" : ""}
          </>
        }
        title={team.name}
        description={
          members.length ? (
            <span className="flex flex-wrap items-center gap-3">
              <span className="flex -space-x-2" aria-hidden="true">
                {members.slice(0, 6).map((m) => (
                  <span key={m.userId} className="rounded-full ring-2 ring-paper">
                    <Avatar name={m.displayName} size="sm" />
                  </span>
                ))}
              </span>
              <span className="text-base">
                {plural(members.length, "member")}: {members.slice(0, 4).map((m) => m.displayName).join(", ")}
                {members.length > 4 ? ` and ${members.length - 4} more` : ""}
              </span>
            </span>
          ) : (
            "No members yet."
          )
        }
        actions={team.archivedAt ? undefined : <NewBriefButton href={paths.newBrief(slug, home)} />}
      />
      <LibraryFilters
        action={base}
        values={sp}
        authors={members.map((m) => ({ value: m.userId, label: m.displayName }))}
        sorts={SORTS}
      />
      <LibraryResults
        companySlug={slug}
        headingId="team-heading"
        heading={sp.q ? `Results for “${sp.q}”` : `${team.name} briefs`}
        rows={page.items.map(toRowData)}
        total={page.total}
        filtered={filtered || invalid}
        nextHref={nextPageHref(base, { q: sp.q, author: sp.author, sort: sp.sort }, page.nextCursor)}
        emptyTitle={`${team.name} hasn’t published a brief yet`}
        emptyDescription="Briefs homed at this team that are visible to you appear here."
        emptyAction={team.archivedAt ? undefined : <NewBriefButton href={paths.newBrief(slug, home)} label={`Write a ${team.name} brief`} />}
      />
      {announcements.length && !filtered ? (
        <section aria-labelledby="announcements-heading">
          <SectionHeading
            id="announcements-heading"
            title={`From ${department.name} and the company`}
            meta={["Parent announcements", "Visible to you"]}
          />
          <BriefingList companySlug={slug} briefings={announcements} label={`From ${department.name} and the company`} />
        </section>
      ) : null}
    </PageContainer>
  );
}
