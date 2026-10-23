import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { blockActionClasses, BriefingOutline, BriefingView, EvidenceList } from "@cerebro/briefing-renderer";
import { blockLabel, type Block } from "@cerebro/briefing-schema";
import { ENGAGEMENT_SETTINGS, getMyThreads, recordBriefingRead, type ThreadDto } from "@cerebro/domain";
import { buttonClasses, cn, focusRing } from "@cerebro/ui";
import { PageBreadcrumb } from "@/components/workspace/page-breadcrumb";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { getBriefingRequestContext } from "@/lib/context";
import { formatDate, isoString } from "@/lib/format";
import {
  briefingCrumbs,
  firstParam,
  loadMeta,
  loadRevision,
  readParams,
  type BriefingPageParams,
} from "@/app/c/[company]/b/[briefing]/_lib/load";
import { AuthorNav, isCollaborator } from "../author-nav";
import { BriefingUnavailable } from "../briefing-state";
import { briefingPaths } from "@/lib/paths";
import { ExplorePanel } from "./explore-panel";
import { FeedbackForm } from "./feedback-form";
import { SectionViewTracker } from "./section-tracker";

type SearchParams = Record<string, string | string[] | undefined>;

const SPECIAL_TARGETS: Record<string, string> = { position: "The position", context: "Why it matters", request: "The request" };

/**
 * The reader for the current publication (`revisionNumber` undefined) or a
 * pinned revision. Renders only the published revision document and its
 * approved evidence; no draft-only data reaches this page.
 */
export async function ReaderPage({
  params,
  searchParams,
  revisionNumber,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<SearchParams>;
  revisionNumber?: number;
}) {
  const { company, briefing } = await readParams(params);
  const sp = await searchParams;
  const rc = await getBriefingRequestContext(company, briefing);
  const c = rc.org.slug;
  const homeHref = rc.isMember ? `/c/${encodeURIComponent(c)}` : "/";

  const load = await loadRevision(rc, briefing, revisionNumber);

  if (load.kind !== "ok") {
    const { meta } = await loadMeta(rc, briefing);
    const caps = meta?.capabilities ?? [];
    if (load.kind === "withdrawn") {
      return (
        <>
          <RailCollapsed />
          {meta && isCollaborator(caps) ? (
            <BriefingUnavailable kind="withdrawn">
              <Link href={briefingPaths.history(c, meta.slug)} className={buttonClasses({ variant: "secondary" })}>
                View history
              </Link>
              {caps.includes("edit") ? (
                <Link href={briefingPaths.edit(c, meta.slug)} className={buttonClasses({ variant: "secondary" })}>
                  Edit the draft
                </Link>
              ) : null}
            </BriefingUnavailable>
          ) : (
            <BriefingUnavailable kind="withdrawn" homeHref={homeHref} />
          )}
        </>
      );
    }
    // A draft that has never been published: only collaborators learn it exists.
    if (meta && !revisionNumber && !meta.currentPublication && caps.includes("view_draft")) {
      if (rc.isMember) {
        return (
          <>
            <RailCollapsed />
            <div className="mx-auto max-w-xl px-4 pt-8 sm:px-6">
              <PageBreadcrumb items={briefingCrumbs(rc.org, meta)} className="mb-0" />
            </div>
            <BriefingUnavailable kind="unpublished">
              {caps.includes("edit") ? (
                <Link href={briefingPaths.edit(c, meta.slug)} className={buttonClasses({})}>
                  Edit the draft
                </Link>
              ) : null}
              {caps.includes("publish") ? (
                <Link href={briefingPaths.preview(c, meta.slug)} className={buttonClasses({ variant: "secondary" })}>
                  Preview &amp; publish
                </Link>
              ) : null}
            </BriefingUnavailable>
          </>
        );
      }
    }
    notFound();
  }

  const rev = load.rev;
  const doc = rev.document;
  const n = rev.revision.revisionNumber;
  const { meta } = await loadMeta(rc, briefing);
  const caps = rev.capabilities;
  const latest = meta?.currentPublication?.revisionNumber ?? null;
  const pinned = revisionNumber !== undefined;
  const readerBase = (q?: Record<string, string | undefined>) => briefingPaths.revision(c, rev.slug, pinned ? n : null, q);

  // Query state: ?perspective=psp_… ?ask=blk_… ?published=N
  const perspectiveParam = firstParam(sp.perspective);
  const perspective = doc.perspectives.find((p) => p.id === perspectiveParam);
  const blocks = new Map<string, { block: Block; section: string }>();
  for (const s of doc.sections) for (const b of s.blocks) blocks.set(b.id, { block: b, section: s.title });
  const askParam = firstParam(sp.ask);
  const askBlock = askParam ? blocks.get(askParam) : undefined;
  const focus = askBlock
    ? { id: askParam!, label: `${askBlock.section}: ${blockLabel(askBlock.block)}` }
    : askParam && SPECIAL_TARGETS[askParam]
      ? { id: askParam, label: SPECIAL_TARGETS[askParam]! }
      : null;
  const publishedParam = firstParam(sp.published);
  const justPublished = publishedParam && Number(publishedParam) === n ? n : null;

  // The viewer's own private reading state (library "Unread" / "New version").
  // Never author analytics; reading never depends on it.
  try {
    await recordBriefingRead(rc.db, rc.ctx, { briefingId: rev.briefingId, revisionNumber: n });
  } catch {
    // Best-effort.
  }

  let threads: ThreadDto[] = [];
  try {
    threads = (await getMyThreads(rc.db, rc.ctx, rev.briefingId)).filter((t) => t.revisionNumber === n);
  } catch {
    threads = [];
  }

  const target = { company: c, briefing: rev.slug, briefingId: rev.briefingId, revisionNumber: n };
  const perspectiveQ = perspective ? perspective.id : undefined;

  const feedbackTargets = doc.sections.flatMap((s) =>
    s.blocks.map((b) => ({ value: b.id, label: `${s.title}: ${blockLabel(b)}` })),
  );

  const evidenceNode = <EvidenceList document={doc} mode="reader" title="Approved evidence" headingLevel={3} />;

  return (
    <>
      <RailCollapsed />
      <SectionViewTracker target={target} sectionIds={doc.sections.map((s) => s.id)} />
      <div className="flex w-full">
        <aside aria-label="Briefing outline" className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-rail shrink-0 self-start overflow-y-auto border-r border-line px-6 py-10 lg:block">
          <BriefingOutline document={doc} perspectiveId={perspective?.id} />
        </aside>

        <div className="min-w-0 flex-1 px-4 pt-8 pb-28 sm:px-8 lg:px-12 xl:pb-16">
          {rc.isMember && meta ? <PageBreadcrumb items={briefingCrumbs(rc.org, meta)} className="mx-auto max-w-measure-wide" /> : null}
          {justPublished ? (
            <div role="status" className="mx-auto mb-6 max-w-measure-wide rounded-md border border-success/30 bg-success-soft px-4 py-3 text-success">
              <strong className="font-semibold">Published version {justPublished}.</strong> Readers in the audience can now see it.
            </div>
          ) : null}

          {isCollaborator(caps) ? (
            <AuthorNav company={c} briefing={rev.slug} capabilities={caps} current="read" className="mx-auto mb-8 max-w-measure-wide" />
          ) : null}

          {!rev.revision.isCurrent ? (
            <div role="note" className="mx-auto mb-6 max-w-measure-wide rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
              <strong className="font-semibold">You're reading version {n}</strong>
              {", published "}
              {formatDate(rev.revision.publishedAt)}.{" "}
              {latest ? (
                <>
                  A newer version ({latest}) is available.{" "}
                  <Link href={briefingPaths.reader(c, rev.slug)} className={cn("font-medium underline underline-offset-2", focusRing)}>
                    Read the latest version
                  </Link>
                </>
              ) : (
                "This is not the current publication."
              )}
            </div>
          ) : pinned ? (
            <p className="mx-auto mb-6 max-w-measure-wide text-sm text-muted">
              This link is pinned to version {n}, which is the current version.
            </p>
          ) : null}

          <details className="mx-auto mb-6 max-w-measure-wide rounded-md border border-line bg-surface px-4 py-3 lg:hidden">
            <summary className={cn("cursor-pointer text-sm font-medium text-ink", focusRing)}>In this briefing</summary>
            <BriefingOutline document={doc} perspectiveId={perspective?.id} title="Sections" className="mt-3" />
          </details>

          <BriefingView
            document={doc}
            mode="reader"
            perspectiveId={perspective?.id}
            revision={{ number: n, publishedAt: isoString(rev.revision.publishedAt), ...(rev.revision.changeSummary ? { changeSummary: rev.revision.changeSummary } : {}) }}
            {...(meta ? { author: { name: meta.owner.displayName } } : {})}
            perspectiveHref={(id) => readerBase({ perspective: id ?? undefined })}
            showEvidence={false}
            headerSlot={
              n > 1 || caps.includes("view_draft") ? (
                <Link href={briefingPaths.history(c, rev.slug, { to: n })} className={cn("underline underline-offset-2 hover:text-ink", focusRing)}>
                  View changes
                </Link>
              ) : undefined
            }
            renderBlockActions={(block) => (
              <Link
                href={`${readerBase({ perspective: perspectiveQ, ask: block.id })}`}
                scroll={false}
                className={blockActionClasses}
                aria-label={`Ask about this: ${blockLabel(block)}`}
              >
                Ask about this
              </Link>
            )}
          />

          {rev.noEvidence ? (
            <p className="mx-auto mt-10 max-w-measure-wide text-sm text-muted">No supporting evidence attached to this version.</p>
          ) : null}

          <section aria-labelledby="respond-title" className="mx-auto mt-16 max-w-measure-wide border-t border-line pt-10">
            <h2 id="respond-title" className="font-serif text-headline text-ink">
              Respond to the author
            </h2>
            <p className="mt-2 max-w-measure text-muted">
              Share a comment, concern or correction about version {n}. This is separate from your private questions.
            </p>
            <div className="mt-6 max-w-measure">
              <FeedbackForm
                company={c}
                briefing={rev.slug}
                briefingId={rev.briefingId}
                revisionNumber={n}
                targets={feedbackTargets}
                {...(askBlock ? { defaultBlockId: askParam } : {})}
              />
            </div>
          </section>
        </div>

        <ExplorePanel
          target={target}
          evidence={evidenceNode}
          evidenceCount={rev.evidence.length}
          focus={focus}
          perspective={perspective ? { id: perspective.id, label: perspective.label } : null}
          {...(perspective ? { perspectiveId: perspective.id } : {})}
          threads={threads}
          minCohort={ENGAGEMENT_SETTINGS.minCohort}
          clearFocusHref={readerBase({ perspective: perspectiveQ })}
        />
      </div>
    </>
  );
}
