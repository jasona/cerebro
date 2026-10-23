import type { Metadata } from "next";
import { listMyDrafts } from "@cerebro/domain";
import { EmptyState } from "@cerebro/ui";
import { BriefingList } from "@/components/library/briefing-row";
import { NewBriefButton } from "@/components/library/library-results";
import { PageContainer, PageHeader, SectionHeading } from "@/components/library/page-header";
import { PencilIcon } from "@/components/icons";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";
import { plural } from "@/lib/format";
import { draftToRowData } from "@/lib/library-view";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My drafts" };

/** Drafts where the user is owner, editor or publisher. Never shown in shared views. */
export default async function DraftsPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const drafts = await loadOrThrow(() => listMyDrafts(ws.db, ws.ctx));
  const rows = drafts.map((d) => draftToRowData(slug, d));

  return (
    <PageContainer>
      <PageHeader
        eyebrow={`${ws.org.name} / My drafts`}
        title="My drafts"
        size="headline"
        description="Work in progress that only you and your collaborators can see. Nothing here is visible to readers until it is explicitly published."
        actions={<NewBriefButton href={paths.newBrief(slug)} />}
      />
      <section aria-labelledby="drafts-heading">
        <SectionHeading id="drafts-heading" title="In progress" meta={[plural(rows.length, "draft"), "Private to collaborators"]} />
        {rows.length === 0 ? (
          <EmptyState
            icon={<PencilIcon size={28} />}
            title="No drafts"
            description="Ask your connected LLM to turn your thinking into a Cerebro brief, or start one here. Drafts stay private until you publish."
            action={<NewBriefButton href={paths.newBrief(slug)} label="Start a brief" />}
            headingLevel={3}
          />
        ) : (
          <BriefingList companySlug={slug} briefings={rows} label="My drafts" />
        )}
      </section>
    </PageContainer>
  );
}
