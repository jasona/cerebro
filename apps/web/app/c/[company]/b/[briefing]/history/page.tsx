import type { Metadata } from "next";
import Link from "next/link";
import { compareRevisions, getDraft, getRevisionDocument, isDomainError, listRevisions, type CompareRevisionsResult } from "@cerebro/domain";
import { buttonClasses, cn, focusRing, StatusPill } from "@cerebro/ui";
import { AuthorPage } from "@/components/briefing/author-nav";
import { DiffView } from "@/components/briefing/diff-view";
import { ERROR_COPY } from "@/components/briefing/labels";
import { briefingPaths } from "@/lib/paths";
import { SubmitButton } from "@/components/briefing/submit-button";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { loadOrThrow } from "@/lib/errors";
import { formatDateTime, isoString } from "@/lib/format";
import { briefingCrumbs, firstParam, positiveInt, requireAuthorView, type BriefingPageParams } from "../_lib/load";
import { withdrawAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Version history" };

/**
 * Revision list, comparison of any two versions (or the draft against the
 * current version, for collaborators), pinned links, and withdrawal.
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { rc, meta, company, briefing } = await requireAuthorView(params, "read");
  const sp = await searchParams;
  const revisions = await loadOrThrow(() => listRevisions(rc.db, rc.ctx, meta.briefingId));
  const caps = meta.capabilities;
  const canDraft = caps.includes("view_draft");
  const numbers = revisions.map((r) => r.revisionNumber);
  const current = revisions.find((r) => r.isCurrent) ?? null;

  // Comparison selection: ?from=&to= (to may be "draft"); ?to=n alone compares with n-1.
  const toParam = firstParam(sp.to);
  const to: number | "draft" | null = toParam === "draft" && canDraft ? "draft" : positiveInt(toParam);
  let from = positiveInt(firstParam(sp.from));
  let toSel: number | "draft" | null = to;
  if (toSel === null && numbers.length >= 2) toSel = numbers[0]!;
  if (toSel !== null && from === null) {
    from = toSel === "draft" ? (current?.revisionNumber ?? numbers[0] ?? null) : numbers.find((n) => n < (toSel as number)) ?? null;
  }

  let comparison: CompareRevisionsResult | null = null;
  let compareError = false;
  const titles = new Map<string, string>();
  if (from !== null && toSel !== null && from !== toSel) {
    try {
      comparison = await compareRevisions(rc.db, rc.ctx, { briefingId: meta.briefingId, from, to: toSel });
      const docs = await Promise.all([
        getRevisionDocument(rc.db, rc.ctx, { slug: briefing, revisionNumber: from }).then((r) => r.document).catch(() => null),
        toSel === "draft"
          ? getDraft(rc.db, rc.ctx, meta.briefingId).then((d) => d.document).catch(() => null)
          : getRevisionDocument(rc.db, rc.ctx, { slug: briefing, revisionNumber: toSel }).then((r) => r.document).catch(() => null),
      ]);
      for (const d of docs) for (const s of d?.sections ?? []) titles.set(s.id, s.title);
    } catch (err) {
      if (!isDomainError(err)) throw err;
      compareError = true;
    }
  }

  const errorCode = firstParam(sp.error);
  const withdrawn = firstParam(sp.withdrawn) === "1";
  const label = (v: number | "draft") => (v === "draft" ? "Current draft" : `Version ${v}`);

  return (
    <>
      <RailCollapsed />
      <AuthorPage
        breadcrumb={rc.isMember ? briefingCrumbs(rc.org, meta, "History") : undefined}
        company={company}
        briefing={briefing}
        capabilities={caps}
        current="history"
        published={!!meta.currentPublication}
        eyebrow={meta.title}
        title="Version history"
        description="Every publication is an immutable version. Stable links follow the current version; pinned links always open one version."
      >
        {withdrawn ? (
          <p role="status" className="mb-6 rounded-md border border-success/30 bg-success-soft px-4 py-3 text-success">
            The publication was withdrawn, along with every earlier version. Readers now see a withdrawn notice.
          </p>
        ) : null}
        {errorCode ? (
          <p role="alert" className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
            {errorCode === "confirm" ? "Type withdraw to confirm." : (ERROR_COPY[errorCode] ?? "Something went wrong.")}
          </p>
        ) : null}

        <div className="grid gap-10 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <section aria-labelledby="revisions-title">
            <h2 id="revisions-title" className="font-serif text-title text-ink">
              Versions
            </h2>
            {revisions.length === 0 ? (
              <p className="mt-3 text-muted">Not published yet.</p>
            ) : (
              <ol className="mt-4 flex flex-col gap-3">
                {revisions.map((r) => (
                  <li key={r.revisionId} className="rounded-lg border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-ink">Version {r.revisionNumber}</h3>
                      {r.isCurrent ? <StatusPill status="published" label="Current" /> : null}
                      {r.withdrawn ? <StatusPill status="withdrawn" /> : null}
                      {!r.isCurrent && !r.withdrawn ? <StatusPill status="superseded" label="Earlier version" /> : null}
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      Published <time dateTime={isoString(r.publishedAt)}>{formatDateTime(r.publishedAt)}</time> by {r.publishedBy.displayName}
                    </p>
                    {r.changeSummary ? <p className="mt-2 text-sm whitespace-pre-line text-fg">{r.changeSummary}</p> : null}
                    <div className="mt-3 flex flex-wrap gap-3 text-sm">
                      {!r.withdrawn ? (
                        <Link href={briefingPaths.pinned(company, briefing, r.revisionNumber)} className={cn("text-accent underline underline-offset-2", focusRing)}>
                          Open pinned version
                        </Link>
                      ) : null}
                      {numbers.some((n) => n < r.revisionNumber) ? (
                        <Link
                          href={briefingPaths.history(company, briefing, { to: r.revisionNumber })}
                          className={cn("text-accent underline underline-offset-2", focusRing)}
                        >
                          Compare with previous
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {current && caps.includes("withdraw") && meta.currentPublication ? (
              <details className="mt-6 rounded-lg border border-danger/30 p-4">
                <summary className={cn("cursor-pointer font-medium text-danger", focusRing)}>Withdraw the current publication</summary>
                <p className="mt-2 text-sm text-fg">
                  Readers will see a withdrawn notice instead of this brief. Earlier versions are withdrawn too, including pinned links to
                  them. This can&apos;t be undone. The draft is kept, so you can publish again.
                </p>
                <form action={withdrawAction} className="mt-3 flex flex-col gap-3">
                  <input type="hidden" name="company" value={company} />
                  <input type="hidden" name="briefing" value={briefing} />
                  <input type="hidden" name="briefingId" value={meta.briefingId} />
                  <input type="hidden" name="publicationId" value={meta.currentPublication.publicationId} />
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="withdraw-confirm" className="text-sm font-medium text-ink">
                      Type <span className="font-mono">withdraw</span> to confirm
                    </label>
                    <input id="withdraw-confirm" name="confirm" required autoComplete="off" className="rounded-md border border-line-strong bg-surface px-3 py-2" />
                  </div>
                  <div>
                    <SubmitButton variant="danger" pendingLabel="Withdrawing…" confirm={`Withdraw version ${current.revisionNumber}? This can't be undone.`}>
                      Withdraw version {current.revisionNumber}
                    </SubmitButton>
                  </div>
                </form>
              </details>
            ) : null}
          </section>

          <section aria-labelledby="compare-title">
            <h2 id="compare-title" className="font-serif text-title text-ink">
              Compare
            </h2>
            {revisions.length || canDraft ? (
              <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="cmp-from" className="text-sm font-medium text-ink">
                    From
                  </label>
                  <select id="cmp-from" name="from" defaultValue={from ?? ""} className="rounded-md border border-line-strong bg-surface px-3 py-2">
                    {numbers.map((n) => (
                      <option key={n} value={n}>
                        Version {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="cmp-to" className="text-sm font-medium text-ink">
                    To
                  </label>
                  <select id="cmp-to" name="to" defaultValue={toSel ?? ""} className="rounded-md border border-line-strong bg-surface px-3 py-2">
                    {canDraft ? <option value="draft">Current draft</option> : null}
                    {numbers.map((n) => (
                      <option key={n} value={n}>
                        Version {n}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className={buttonClasses({ variant: "secondary" })}>
                  Compare
                </button>
                {canDraft && current ? (
                  <Link href={briefingPaths.history(company, briefing, { from: current.revisionNumber, to: "draft" })} className={buttonClasses({ variant: "ghost" })}>
                    Draft vs current
                  </Link>
                ) : null}
              </form>
            ) : null}

            <div className="mt-6">
              {comparison && from !== null && toSel !== null ? (
                <>
                  <p className="mb-4 text-sm text-muted">
                    {label(from)} → {label(toSel)}
                    {toSel === "draft" && "lockVersion" in comparison.to ? ` (draft version ${comparison.to.lockVersion}, as it would publish)` : ""}
                  </p>
                  <DiffView diff={comparison.diff} sectionTitles={titles} />
                </>
              ) : compareError ? (
                <p className="text-muted">Those versions can&apos;t be compared. You may not have access to one of them.</p>
              ) : from !== null && from === toSel ? (
                <p className="text-muted">Choose two different versions.</p>
              ) : (
                <p className="text-muted">
                  {numbers.length < 2 && !canDraft ? "There is only one version, so there is nothing to compare yet." : "Choose two versions to compare."}
                </p>
              )}
            </div>
          </section>
        </div>
      </AuthorPage>
    </>
  );
}
