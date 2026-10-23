import type { Metadata } from "next";
import { getDraft, getSourceExtraction, listBriefingSources, type SourceExtractionDto } from "@cerebro/domain";
import { AuthorPage } from "@/components/briefing/author-nav";
import { BriefingEditor } from "@/components/briefing/editor/editor";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { loadOrThrow } from "@/lib/errors";
import { briefingCrumbs, requireAuthorView, type BriefingPageParams } from "../_lib/load";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit draft" };

const MAX_SOURCES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal structured draft editor. Collaborators with `edit` only. */
export default async function EditBriefingPage({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { rc, meta, company, briefing } = await requireAuthorView(params, "edit");
  const sp = await searchParams;
  const draft = await loadOrThrow(() => getDraft(rc.db, rc.ctx, meta.briefingId));

  // Every source linked to the briefing (uploads, handoffs), plus any named in
  // the URL or referenced by draft evidence that is not linked (defensive).
  const linked = await listBriefingSources(rc.db, rc.ctx, meta.briefingId).catch(() => []);
  const fromQuery = ([] as string[]).concat(sp.source ?? []).filter((s) => UUID.test(s));
  const fromEvidence = draft.document.evidence.flatMap((e) => (e.sourceRef ? [e.sourceRef.sourceId] : []));
  const sourceIds = [...new Set([...fromQuery, ...linked.map((s) => s.sourceId), ...fromEvidence])].slice(0, MAX_SOURCES);
  const sources = (
    await Promise.all(
      sourceIds.map((id) =>
        getSourceExtraction(rc.db, rc.ctx, id).catch(() => null as SourceExtractionDto | null),
      ),
    )
  ).filter((s): s is SourceExtractionDto => s !== null);

  return (
    <>
      <RailCollapsed />
      <AuthorPage
        breadcrumb={rc.isMember ? briefingCrumbs(rc.org, meta, "Edit") : undefined}
        company={company}
        briefing={briefing}
        capabilities={meta.capabilities}
        current="edit"
        published={!!meta.currentPublication}
        eyebrow={`Draft · ${meta.home.label}`}
        title={draft.document.title}
        description={
          meta.currentPublication
            ? `Changes here stay private until you publish a new version. Readers currently see version ${meta.currentPublication.revisionNumber}.`
            : "This draft is private to collaborators until you publish it."
        }
        width="wide"
      >
        {sp.upload === "rejected" || sp.upload === "failed" || sp.upload === "limited" ? (
          <p role="alert" className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {sp.upload === "rejected"
              ? "The draft was created, but the uploaded file was not accepted (unsupported, too large or unreadable). Nothing from it was attached."
              : sp.upload === "limited"
                ? "The draft was created, but too many files were uploaded recently, so this one was not attached. Wait a little, then upload it again from a new brief, or continue writing here."
                : "The draft was created, but the file couldn't be stored. Try uploading it again from a new brief, or continue writing here."}
          </p>
        ) : null}
        <BriefingEditor
          company={company}
          briefing={briefing}
          briefingId={meta.briefingId}
          document={draft.document}
          lockVersion={draft.lockVersion}
          issues={draft.issues}
          sources={sources}
          canPublish={meta.capabilities.includes("publish")}
        />
      </AuthorPage>
    </>
  );
}
