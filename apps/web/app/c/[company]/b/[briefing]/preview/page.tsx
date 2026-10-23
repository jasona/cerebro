import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { BriefingView } from "@cerebro/briefing-renderer";
import { createPreview, type PreviewEvidenceDTO } from "@cerebro/domain";
import { Badge, buttonClasses, cn, focusRing } from "@cerebro/ui";
import { AuthorPage } from "@/components/briefing/author-nav";
import { ERROR_COPY, explicitAudience, STALE_REASONS } from "@/components/briefing/labels";
import { briefingPaths } from "@/lib/paths";
import { SubmitButton } from "@/components/briefing/submit-button";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { loadOrThrow } from "@/lib/errors";
import { formatDateTime, plural } from "@/lib/format";
import { briefingCrumbs, firstParam, requireAuthorView, type BriefingPageParams } from "../_lib/load";
import { publishAction, setEvidenceStatusAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Preview and publish" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-line py-3 first:border-t-0 first:pt-0">
      <dt className="text-xs font-medium tracking-[0.12em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-fg">{children}</dd>
    </div>
  );
}

function EvidenceItemForm({
  item,
  hidden,
}: {
  item: PreviewEvidenceDTO;
  hidden: Record<string, string | number>;
}) {
  const actions: { status: PreviewEvidenceDTO["status"]; label: string; variant: "primary" | "secondary" | "ghost" }[] =
    item.status === "candidate"
      ? [
          { status: "approved", label: "Approve", variant: "primary" },
          { status: "excluded", label: "Exclude", variant: "secondary" },
        ]
      : item.status === "approved"
        ? [
            { status: "excluded", label: "Exclude", variant: "secondary" },
            { status: "candidate", label: "Back to candidate", variant: "ghost" },
          ]
        : [
            { status: "approved", label: "Approve", variant: "secondary" },
            { status: "candidate", label: "Back to candidate", variant: "ghost" },
          ];
  return (
    <li id={`review-${item.id}`} className="rounded-md border border-line bg-paper p-3">
      <p className="font-medium text-ink">{item.title}</p>
      <p className="mt-0.5 text-xs text-muted">
        {item.attribution ?? "No attribution"} · origin: {item.origin === "llm_handoff" ? "connected LLM" : item.origin}
      </p>
      <blockquote className="mt-2 line-clamp-4 border-l-2 border-line-strong pl-3 text-sm text-fg">{item.excerpt}</blockquote>
      <form action={setEvidenceStatusAction} className="mt-3 flex flex-wrap gap-2">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="evidenceId" value={item.id} />
        {actions.map((a) => (
          <SubmitButton key={a.status} name="status" value={a.status} variant={a.variant} size="sm" ariaLabel={`${a.label}: ${item.title}`} pendingLabel="Updating…">
            {a.label}
          </SubmitButton>
        ))}
      </form>
    </li>
  );
}

/**
 * Reader preview plus the review the publisher approves: home, explicit
 * audience, sections, evidence status (approvable here), issues, change
 * summary and expiry. Publish releases exactly this preview.
 */
export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { rc, meta, company, briefing } = await requireAuthorView(params, "publish");
  const sp = await searchParams;
  const preview = await loadOrThrow(() => createPreview(rc.db, rc.ctx, { briefingId: meta.briefingId }));
  const idempotencyKey = randomUUID();

  const stale = (firstParam(sp.stale) ?? "").split(",").filter(Boolean);
  const errorCode = firstParam(sp.error);
  const perspectiveId = preview.document.perspectives.find((p) => p.id === firstParam(sp.perspective))?.id;
  const errors = preview.issues.filter((i) => i.severity === "error");
  const warnings = preview.issues.filter((i) => i.severity === "warning");
  const { approved, candidates, excluded } = preview.evidence;

  const dropped = new Map<string, number>();
  for (const d of preview.droppedRefs) dropped.set(d.blockId, (dropped.get(d.blockId) ?? 0) + 1);
  const annotations = Object.fromEntries(
    [...dropped].map(([blockId, count]) => [
      blockId,
      <span key={blockId}>
        <strong className="font-semibold">This claim will publish without evidence.</strong>{" "}
        {plural(count, "reference")} to unapproved evidence will be removed.
      </span>,
    ]),
  );

  const hidden = { company, briefing, briefingId: meta.briefingId, expectedVersion: preview.draftVersion };
  const minutesLeft = Math.max(0, Math.round((preview.expiresAt.getTime() - Date.now()) / 60_000));
  const defaultSummary = preview.currentRevisionNumber ? preview.changeSummary.join("\n").slice(0, 2000) : "";

  return (
    <>
      <RailCollapsed />
      <AuthorPage
        breadcrumb={rc.isMember ? briefingCrumbs(rc.org, meta, "Preview & publish") : undefined}
        company={company}
        briefing={briefing}
        capabilities={meta.capabilities}
        current="preview"
        published={!!meta.currentPublication}
        eyebrow={preview.currentRevisionNumber ? `Next version: ${preview.currentRevisionNumber + 1}` : "First publication"}
        title="Preview and publish"
        description="Review exactly what readers will receive and who will receive it. Nothing is published until you choose Publish."
      >
        {stale.length ? (
          <div role="alert" className="mb-6 rounded-lg border border-warning/40 bg-warning-soft p-4">
            <p className="font-medium text-warning">Not published: the briefing changed after the preview you reviewed.</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-fg">
              {stale.map((r) => (
                <li key={r}>{STALE_REASONS[r] ?? STALE_REASONS.unknown}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-fg">This is a fresh preview of the current draft. Review it again before publishing.</p>
          </div>
        ) : null}
        {errorCode ? (
          <div role="alert" className="mb-6 rounded-lg border border-danger/40 bg-danger-soft p-4 text-sm font-medium text-danger">
            {ERROR_COPY[errorCode] ?? "Something went wrong. Nothing was published."}
          </div>
        ) : null}

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <aside aria-labelledby="review-title" className="xl:sticky xl:top-20 xl:order-2 xl:max-h-[calc(100dvh-6rem)] xl:self-start xl:overflow-y-auto">
            <div className="rounded-lg border border-line bg-surface p-5">
              <h2 id="review-title" className="font-serif text-title text-ink">
                Review
              </h2>
              <dl className="mt-4">
                <Row label="Title">{preview.document.title}</Row>
                <Row label="Home">{preview.home.label}</Row>
                <Row label="Audience">
                  <span className="font-medium text-ink">{explicitAudience(preview.audience)}</span>
                  {preview.audience.namedReaders?.length ? (
                    <span className="mt-1 block">
                      Plus named readers: {preview.audience.namedReaders.map((r) => r.displayName).join(", ")}
                    </span>
                  ) : null}
                  {meta.capabilities.includes("manage_access") ? (
                    <Link href={briefingPaths.access(company, briefing)} className={cn("mt-1 block text-accent underline underline-offset-2", focusRing)}>
                      Change audience or home
                    </Link>
                  ) : null}
                </Row>
                <Row label="Included sections">
                  {preview.includedSections.length ? (
                    <ol className="list-decimal pl-5">
                      {preview.includedSections.map((s) => (
                        <li key={s.id}>
                          {s.title} <span className="text-muted">({plural(s.blockCount, "block")})</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    "No sections"
                  )}
                </Row>
                <Row label="Evidence">
                  <p>
                    <Badge tone="success">{approved.length} approved</Badge> <Badge tone="warning">{candidates.length} candidate</Badge>{" "}
                    <Badge>{excluded.length} excluded</Badge>
                  </p>
                  {approved.length === 0 ? (
                    <p className="mt-2 font-medium text-warning">No supporting evidence attached. Readers will see that no evidence is attached.</p>
                  ) : null}
                  <p className="mt-2 text-muted">Only approved excerpts publish. Candidates and excluded items stay private.</p>
                  {preview.droppedRefs.length ? (
                    <p className="mt-2 text-warning">{plural(dropped.size, "claim")} will publish without evidence (marked in the preview).</p>
                  ) : null}
                </Row>
              </dl>

              {candidates.length ? (
                <section aria-labelledby="candidates-title" className="mt-4">
                  <h3 id="candidates-title" className="text-sm font-medium text-ink">
                    Candidates awaiting your decision
                  </h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {candidates.map((e) => (
                      <EvidenceItemForm key={e.id} item={e} hidden={hidden} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {approved.length || excluded.length ? (
                <details className="mt-4">
                  <summary className={cn("cursor-pointer text-sm font-medium text-accent", focusRing)}>
                    Approved and excluded evidence ({approved.length + excluded.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {[...approved, ...excluded].map((e) => (
                      <EvidenceItemForm key={e.id} item={e} hidden={hidden} />
                    ))}
                  </ul>
                </details>
              ) : null}

              <section aria-labelledby="issues-title" className="mt-5">
                <h3 id="issues-title" className="text-sm font-medium text-ink">
                  Issues
                </h3>
                {errors.length === 0 && warnings.length === 0 ? <p className="mt-1 text-sm text-success">No issues found.</p> : null}
                {errors.length ? (
                  <div className="mt-2 rounded-md border border-danger/40 bg-danger-soft p-3">
                    <p className="text-sm font-medium text-danger">Errors — these block publication ({errors.length})</p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-fg">
                      {errors.map((i, k) => (
                        <li key={k}>{i.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {warnings.length ? (
                  <div className="mt-2 rounded-md border border-warning/40 bg-warning-soft p-3">
                    <p className="text-sm font-medium text-warning">Warnings — you can publish with these ({warnings.length})</p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-fg">
                      {warnings.map((i, k) => (
                        <li key={k}>{i.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              <form action={publishAction} className="mt-5 flex flex-col gap-3 border-t border-line pt-5">
                <input type="hidden" name="company" value={company} />
                <input type="hidden" name="briefing" value={briefing} />
                <input type="hidden" name="briefingId" value={meta.briefingId} />
                <input type="hidden" name="previewId" value={preview.previewId} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                <div>
                  <p className="text-sm font-medium text-ink">
                    {preview.currentRevisionNumber ? `Changes since version ${preview.currentRevisionNumber}` : "Change summary"}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-fg">
                    {preview.changeSummary.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="changeSummary" className="text-sm font-medium text-ink">
                    Change summary for readers
                  </label>
                  <textarea
                    id="changeSummary"
                    name="changeSummary"
                    rows={4}
                    maxLength={2000}
                    defaultValue={defaultSummary}
                    aria-describedby="changeSummary-hint"
                    className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-fg"
                  />
                  <p id="changeSummary-hint" className="text-sm text-muted">
                    Shown with the new version as “What changed”. Edit it to describe the material change.
                  </p>
                </div>
                <p className="text-sm text-muted">
                  Preview of draft version {preview.draftVersion}. Expires {formatDateTime(preview.expiresAt)}
                  {minutesLeft ? ` (in about ${plural(minutesLeft, "minute")})` : ""}.
                </p>
                {!preview.canPublish ? (
                  <p role="note" className="text-sm font-medium text-danger">
                    Fix the errors above before publishing.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {preview.canPublish ? (
                    <SubmitButton pendingLabel="Publishing…">
                      {preview.currentRevisionNumber ? `Publish version ${preview.currentRevisionNumber + 1}` : "Publish"}
                    </SubmitButton>
                  ) : (
                    <span className={buttonClasses({ className: "pointer-events-none opacity-50" })} aria-disabled="true">
                      Publish
                    </span>
                  )}
                  <Link href={briefingPaths.edit(company, briefing)} className={buttonClasses({ variant: "secondary" })}>
                    Keep as draft
                  </Link>
                </div>
                <p className="text-xs text-muted">
                  Publishing releases this exact content to {explicitAudience(preview.audience)}. It creates an immutable version.
                </p>
              </form>
            </div>
          </aside>

          <section aria-label="Reader preview" className="min-w-0 xl:order-1">
            <BriefingView
              document={preview.document}
              mode="preview"
              annotations={annotations}
              perspectiveId={perspectiveId}
              perspectiveHref={(id) => briefingPaths.preview(company, briefing, { perspective: id ?? undefined })}
              revision={{ number: (preview.currentRevisionNumber ?? 0) + 1 }}
              author={{ name: meta.owner.displayName }}
              homePath={preview.home.label.split(" / ")}
            />
          </section>
        </div>
      </AuthorPage>
    </>
  );
}
