import type { Metadata } from "next";
import { listLibrary } from "@cerebro/domain";
import { LibraryResults, NewBriefButton, nextPageHref } from "@/components/library/library-results";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { toRowData } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Recently updated" };

/** Latest releases across the company, newest first. */
export default async function RecentPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { company } = await params;
  const { cursor } = await searchParams;
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const page = await loadOrThrow(() => listLibrary(ws.db, ws.ctx, { sort: "recent", cursor: cursor ?? null }));

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / Recently updated`}
        title="Recently updated"
        size="headline"
        description="New publications and new versions, most recent first. An update means a new version was released, not that anyone has read it."
        actions={<NewBriefButton href={paths.newBrief(slug)} />}
      />
      <LibraryResults
        companySlug={slug}
        headingId="recent-heading"
        heading="Latest releases"
        rows={page.items.map(toRowData)}
        total={page.total}
        filtered={false}
        nextHref={nextPageHref(paths.recent(slug), {}, page.nextCursor)}
        emptyTitle="Nothing published yet"
        emptyDescription="Published briefs and new versions visible to you will appear here."
      />
    </PageContainer>
  );
}
