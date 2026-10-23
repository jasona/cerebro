import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ENGAGEMENT_DISCLOSURE,
  ENGAGEMENT_LABELS,
  getEngagementSummary,
  listRevisions,
  listSubmittedFeedback,
  type CohortCount,
  type FeedbackDto,
} from "@cerebro/domain";
import { Badge, cn, focusRing, Select } from "@cerebro/ui";
import { AuthorPage } from "@/components/briefing/author-nav";
import { briefingPaths } from "@/lib/paths";
import { ActionForm } from "@/components/forms/action-form";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { loadOrThrow } from "@/lib/errors";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { briefingCrumbs, requireAuthorView, type BriefingPageParams } from "../_lib/load";
import { requestTopicSummaryAction, resolveFeedbackAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Engagement" };

/** Visible labels for the three kinds of information (never mixed). */
const KIND = {
  [ENGAGEMENT_LABELS.measured]: { title: "Measured events", note: "Counts of reader actions. They show activity, not understanding or agreement." },
  [ENGAGEMENT_LABELS.generated]: { title: "Generated topic summaries", note: "Automated groupings of private reader questions. They may be imprecise and never include question text." },
  [ENGAGEMENT_LABELS.statements]: { title: "Reader statements", note: "Feedback readers explicitly chose to send you, with their name." },
} as const;

function KindHeader({ kind, id }: { kind: keyof typeof KIND; id: string }) {
  return (
    <div className="mb-4">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">{kind.replace(/_/g, " ")}</p>
      <h2 id={id} className="mt-1 font-serif text-title text-ink">
        {KIND[kind].title}
      </h2>
      <p className="mt-1 text-sm text-muted">{KIND[kind].note}</p>
    </div>
  );
}

function Cohort({ c, minCohort }: { c: CohortCount; minCohort: number }) {
  if (c.suppressed || c.value === null) return <span className="text-muted">Fewer than {minCohort} readers — hidden for privacy</span>;
  return <>{c.value}</>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg text-ink tabular-nums">{children}</dd>
    </div>
  );
}

const STATUS_TONE: Record<FeedbackDto["status"], "warning" | "info" | "success" | "neutral"> = {
  submitted: "warning",
  acknowledged: "info",
  resolved: "success",
  dismissed: "neutral",
};

export default async function EngagementPage({ params }: { params: Promise<BriefingPageParams> }) {
  const { rc, meta, company, briefing } = await requireAuthorView(params, "view_engagement");
  const [summary, feedback, revisions] = await Promise.all([
    loadOrThrow(() => getEngagementSummary(rc.db, rc.ctx, meta.briefingId)),
    loadOrThrow(() => listSubmittedFeedback(rc.db, rc.ctx, meta.briefingId)),
    loadOrThrow(() => listRevisions(rc.db, rc.ctx, meta.briefingId)),
  ]);
  const hidden = (
    <>
      <input type="hidden" name="company" value={company} />
      <input type="hidden" name="briefing" value={briefing} />
      <input type="hidden" name="briefingId" value={meta.briefingId} />
    </>
  );
  const open = feedback.filter((f) => f.status === "submitted" || f.status === "acknowledged");
  const closed = feedback.filter((f) => !(f.status === "submitted" || f.status === "acknowledged"));
  const revisionOptions = [{ value: "", label: "No linked version" }, ...revisions.map((r) => ({ value: String(r.revisionNumber), label: `Version ${r.revisionNumber}` }))];

  const feedbackItem = (f: FeedbackDto) => (
    <li key={f.id} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[f.status]}>{f.status[0]!.toUpperCase() + f.status.slice(1)}</Badge>
        <Badge>{f.type}</Badge>
        <span className="text-sm text-muted">
          {f.submittedBy.displayName} · version {f.revisionNumber} · {formatDateTime(f.submittedAt)}
        </span>
      </div>
      <blockquote className="mt-3 border-l-2 border-accent pl-3 whitespace-pre-line text-ink">{f.text}</blockquote>
      {f.block ? (
        <p className="mt-2 text-sm text-muted">
          About {f.block.sectionTitle ? `“${f.block.sectionTitle}”: ` : ""}
          {f.block.title}
          {f.block.presentInCurrentRevision ? (
            <>
              {" · "}
              <Link href={`${briefingPaths.pinned(company, briefing, f.revisionNumber)}#${f.block.blockId}`} className={cn("text-accent underline underline-offset-2", focusRing)}>
                View in version {f.revisionNumber}
              </Link>
            </>
          ) : (
            " · no longer in the current version"
          )}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">About the whole briefing</p>
      )}
      {f.resolutionRevisionNumber ? (
        <p className="mt-2 text-sm text-success">
          Addressed in{" "}
          <Link href={briefingPaths.pinned(company, briefing, f.resolutionRevisionNumber)} className={cn("underline underline-offset-2", focusRing)}>
            version {f.resolutionRevisionNumber}
          </Link>
        </p>
      ) : null}
      <ActionForm action={resolveFeedbackAction} submitLabel="Update" submitVariant="secondary" submitSize="sm" inline className="mt-3">
        {hidden}
        <input type="hidden" name="feedbackId" value={f.id} />
        <Select
          id={`fb-${f.id}-status`}
          name="status"
          label="Status"
          defaultValue={f.status}
          options={[
            { value: "submitted", label: "Submitted" },
            { value: "acknowledged", label: "Acknowledged" },
            { value: "resolved", label: "Resolved" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
        <Select
          id={`fb-${f.id}-rev`}
          name="resolutionRevision"
          label="Addressed in"
          defaultValue={f.resolutionRevisionNumber ? String(f.resolutionRevisionNumber) : ""}
          options={revisionOptions}
        />
      </ActionForm>
    </li>
  );

  return (
    <>
      <RailCollapsed />
      <AuthorPage
        breadcrumb={rc.isMember ? briefingCrumbs(rc.org, meta, "Engagement") : undefined}
        company={company}
        briefing={briefing}
        capabilities={meta.capabilities}
        current="engagement"
        published={!!meta.currentPublication}
        eyebrow={meta.title}
        title="Engagement"
        description="Use this to improve the communication. Activity is not agreement, and silence is not understanding."
      >
        <aside aria-label="About these numbers" className="mb-10 rounded-lg border border-info/30 bg-info-soft p-4 text-sm text-fg">
          <p className="font-medium text-info">What this shows</p>
          <p className="mt-1">{summary.disclosure || ENGAGEMENT_DISCLOSURE}</p>
        </aside>

        <div className="flex flex-col gap-12">
          <section aria-labelledby="eng-statements" data-label={ENGAGEMENT_LABELS.statements}>
            <KindHeader kind={ENGAGEMENT_LABELS.statements} id="eng-statements" />
            <h3 className="text-sm font-medium text-ink">Unresolved ({open.length})</h3>
            {open.length ? <ul className="mt-3 flex flex-col gap-3">{open.map(feedbackItem)}</ul> : <p className="mt-2 text-sm text-muted">No unresolved feedback.</p>}
            {closed.length ? (
              <details className="mt-6">
                <summary className={cn("cursor-pointer text-sm font-medium text-accent", focusRing)}>Resolved and dismissed ({closed.length})</summary>
                <ul className="mt-3 flex flex-col gap-3">{closed.map(feedbackItem)}</ul>
              </details>
            ) : null}
          </section>

          <section aria-labelledby="eng-topics" data-label={ENGAGEMENT_LABELS.generated} className="border-t border-line pt-10">
            <KindHeader kind={ENGAGEMENT_LABELS.generated} id="eng-topics" />
            {summary.topics.items.length ? (
              <ul className="flex flex-col gap-2">
                {summary.topics.items.map((t, i) => (
                  <li key={i} className="rounded-md border border-line bg-surface p-3">
                    <p className="text-ink">{t.topic}</p>
                    <p className="mt-0.5 text-sm text-muted">
                      {plural(t.questionCount, "question")} from {plural(t.readerCount, "reader")}
                      {t.revisionNumber ? ` · version ${t.revisionNumber}` : ""} · generated {formatDate(t.generatedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No topic summaries yet.</p>
            )}
            {summary.topics.suppressedQuestionCount ? (
              <p className="mt-3 text-sm text-muted">
                {plural(summary.topics.suppressedQuestionCount, "question")} in topics with fewer than {summary.minCohort} readers — hidden for privacy.
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted">
                Questions from fewer than {summary.minCohort} readers are not counted or summarized here, for privacy.
              </p>
            )}
            <ActionForm action={requestTopicSummaryAction} submitLabel="Refresh topic summary" submitVariant="secondary" pendingLabel="Requesting…" className="mt-4">
              {hidden}
            </ActionForm>
          </section>

          <section aria-labelledby="eng-measured" data-label={ENGAGEMENT_LABELS.measured} className="border-t border-line pt-10">
            <KindHeader kind={ENGAGEMENT_LABELS.measured} id="eng-measured" />
            {summary.revisions.length ? (
              <ul className="flex flex-col gap-4">
                {[...summary.revisions].reverse().map((r) => (
                  <li key={r.revisionNumber} className="rounded-lg border border-line bg-surface p-4">
                    <h3 className="font-medium text-ink">
                      Version {r.revisionNumber}
                      {r.isCurrent ? <Badge tone="success" className="ml-2">Current</Badge> : null}
                      {r.publishedAt ? <span className="ml-2 text-sm font-normal text-muted">published {formatDate(r.publishedAt)}</span> : null}
                    </h3>
                    <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
                      <Stat label="Opens"><Cohort c={{ value: r.measured.opens, suppressed: r.measured.opensSuppressed }} minCohort={summary.minCohort} /></Stat>
                      <Stat label="Distinct readers who opened">
                        <Cohort c={r.measured.distinctReaders} minCohort={summary.minCohort} />
                      </Stat>
                      <Stat label="Section views"><Cohort c={{ value: r.measured.sectionViews, suppressed: r.measured.sectionViewsSuppressed }} minCohort={summary.minCohort} /></Stat>
                      <Stat label="Evidence opens"><Cohort c={{ value: r.measured.evidenceOpens, suppressed: r.measured.evidenceOpensSuppressed }} minCohort={summary.minCohort} /></Stat>
                      <Stat label="Questions asked (count only)"><Cohort c={{ value: r.measured.questionsAsked, suppressed: r.measured.questionsAskedSuppressed }} minCohort={summary.minCohort} /></Stat>
                    </dl>
                    <p className="mt-3 text-sm text-muted">
                      Reader statements on this version: {r.statements.submittedFeedback} submitted, {r.statements.unresolvedFeedback} unresolved.
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing published yet.</p>
            )}
          </section>
        </div>
      </AuthorPage>
    </>
  );
}
