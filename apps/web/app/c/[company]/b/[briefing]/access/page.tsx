import type { Metadata } from "next";
import Link from "next/link";
import { getOrgTree, listAccess, listRevisions, listShareLinks, type AudienceDTO } from "@cerebro/domain";
import { Badge, buttonClasses, cn, focusRing, Input, Select } from "@cerebro/ui";
import { AuthorPage } from "@/components/briefing/author-nav";
import { ERROR_COPY, explicitAudience } from "@/components/briefing/labels";
import { briefingPaths } from "@/lib/paths";
import { SubmitButton } from "@/components/briefing/submit-button";
import { ActionForm } from "@/components/forms/action-form";
import { RailCollapsed } from "@/components/workspace/shell-context";
import { loadOrThrow } from "@/lib/errors";
import { formatDate, formatDateTime } from "@/lib/format";
import { briefingCrumbs, firstParam, requireAuthorView, type BriefingPageParams } from "../_lib/load";
import {
  changeAudienceAction,
  createShareLinkAction,
  grantAccessAction,
  moveHomeAction,
  revokeGrantAction,
  revokeShareLinkAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Access" };

const LINK_STATE = { active: "success", expired: "warning", revoked: "neutral" } as const;

function audienceKey(a: AudienceDTO): string {
  if (a.visibility === "department" && a.department) return `department:${a.department.id}`;
  if (a.visibility === "team" && a.team) return `team:${a.team.id}`;
  return a.visibility;
}

/**
 * Audience (who can read), home (where it lives), direct grants and share
 * links. Owner-only (`manage_access`); the domain enforces every change.
 */
export default async function AccessPage({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { rc, meta, company, briefing } = await requireAuthorView(params, "manage_access");
  const sp = await searchParams;
  const [access, links, revisions, tree] = await Promise.all([
    loadOrThrow(() => listAccess(rc.db, rc.ctx, meta.briefingId)),
    loadOrThrow(() => listShareLinks(rc.db, rc.ctx, meta.briefingId)),
    loadOrThrow(() => listRevisions(rc.db, rc.ctx, meta.briefingId)),
    loadOrThrow(() => getOrgTree(rc.db, rc.ctx)),
  ]);
  const departments = tree.departments.filter((d) => !d.archivedAt);
  const hidden = (
    <>
      <input type="hidden" name="company" value={company} />
      <input type="hidden" name="briefing" value={briefing} />
      <input type="hidden" name="briefingId" value={meta.briefingId} />
    </>
  );

  const audienceOptions = [
    { value: "company", label: `Everyone at ${rc.org.name} (company-wide)` },
    ...departments.flatMap((d) => [
      { value: `department:${d.id}`, label: `${d.name} department (including its teams)` },
      ...d.teams.filter((t) => !t.archivedAt).map((t) => ({ value: `team:${t.id}`, label: `${t.name} team (${d.name})` })),
    ]),
    { value: "restricted", label: "Named readers only (direct grants)" },
  ];
  const homeOptions = [
    { value: "", label: rc.org.name },
    ...departments.flatMap((d) => [
      { value: `d:${d.id}`, label: `${rc.org.name} / ${d.name}` },
      ...d.teams.filter((t) => !t.archivedAt).map((t) => ({ value: `t:${t.id}`, label: `${rc.org.name} / ${d.name} / ${t.name}` })),
    ]),
  ];
  const currentHome = meta.home.team ? `t:${meta.home.team.id}` : meta.home.department ? `d:${meta.home.department.id}` : "";
  const currentAudience = audienceKey(meta.audience);
  const proposed = firstParam(sp.audience);
  const proposedLabel = proposed && proposed !== currentAudience ? audienceOptions.find((o) => o.value === proposed)?.label : undefined;
  const errorCode = firstParam(sp.error);
  const saved = firstParam(sp.saved);
  const revisionOptions = revisions.filter((r) => !r.withdrawn).map((r) => ({ value: String(r.revisionNumber), label: `Version ${r.revisionNumber}` }));

  return (
    <>
      <RailCollapsed />
      <AuthorPage
        breadcrumb={rc.isMember ? briefingCrumbs(rc.org, meta, "Access") : undefined}
        company={company}
        briefing={briefing}
        capabilities={meta.capabilities}
        current="access"
        published={!!meta.currentPublication}
        eyebrow={meta.title}
        title="Access"
        description="Who can read this briefing, where it lives in the library, and who can work on it."
        width="narrow"
      >
        {errorCode ? (
          <p role="alert" className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
            {ERROR_COPY[errorCode] ?? "Something went wrong."}
          </p>
        ) : null}
        {saved === "audience" ? (
          <p role="status" className="mb-6 rounded-md border border-success/30 bg-success-soft px-4 py-3 text-success">
            Audience changed to {explicitAudience(meta.audience)}. Any open publication preview must be reviewed again.
          </p>
        ) : null}

        <div className="flex flex-col gap-12">
          {/* Audience */}
          <section aria-labelledby="audience-title">
            <h2 id="audience-title" className="font-serif text-title text-ink">
              Audience
            </h2>
            <p className="mt-1 text-muted">Who can read published versions. Drafts are never visible to readers.</p>
            <p className="mt-3 rounded-md border border-line bg-surface px-4 py-3 text-ink">
              <span className="text-sm text-muted">Current audience: </span>
              <strong className="font-medium">{explicitAudience(meta.audience)}</strong>
            </p>
            {proposedLabel ? (
              <div role="alertdialog" aria-labelledby="audience-confirm-title" className="mt-4 rounded-lg border border-warning/40 bg-warning-soft p-4">
                <h3 id="audience-confirm-title" className="font-medium text-warning">
                  Confirm audience change
                </h3>
                <dl className="mt-2 grid gap-1 text-sm text-fg sm:grid-cols-[6rem_1fr]">
                  <dt className="font-medium">Before</dt>
                  <dd>{explicitAudience(meta.audience)}</dd>
                  <dt className="font-medium">After</dt>
                  <dd>{proposedLabel}</dd>
                </dl>
                <p className="mt-2 text-sm text-fg">
                  This changes who can read the published briefing{meta.currentPublication ? " immediately" : " once it is published"}. Direct grants
                  are kept.
                </p>
                <form action={changeAudienceAction} className="mt-3 flex flex-wrap gap-2">
                  {hidden}
                  <input type="hidden" name="audience" value={proposed} />
                  <SubmitButton pendingLabel="Changing…">Change audience</SubmitButton>
                  <Link href={briefingPaths.access(company, briefing)} className={buttonClasses({ variant: "ghost" })}>
                    Cancel
                  </Link>
                </form>
              </div>
            ) : (
              <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
                <Select id="audience-select" name="audience" label="New audience" defaultValue={currentAudience} options={audienceOptions} />
                <button type="submit" className={buttonClasses({ variant: "secondary" })}>
                  Review change
                </button>
              </form>
            )}
          </section>

          {/* Home */}
          <section aria-labelledby="home-title" className="border-t border-line pt-10">
            <h2 id="home-title" className="font-serif text-title text-ink">
              Home
            </h2>
            <p className="mt-1 text-muted">
              Where the briefing appears in the library. Currently: <span className="text-ink">{meta.home.label}</span>.{" "}
              <strong className="font-medium text-ink">Moving it does not change the audience.</strong>
            </p>
            <ActionForm action={moveHomeAction} submitLabel="Move" submitVariant="secondary" inline className="mt-4">
              {hidden}
              <Select id="home-select" name="home" label="Move to" defaultValue={currentHome} options={homeOptions} />
            </ActionForm>
          </section>

          {/* Grants */}
          <section aria-labelledby="grants-title" className="border-t border-line pt-10">
            <h2 id="grants-title" className="font-serif text-title text-ink">
              People with direct access
            </h2>
            <p className="mt-1 text-muted">Readers can read published versions; editors can edit the draft; publishers can also publish.</p>
            <ul className="mt-4 flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="text-ink">{access.owner.displayName}</span>
                <Badge tone="accent">Owner</Badge>
              </li>
              {access.grants.map((g) => (
                <li key={g.grantId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-ink">
                      {g.displayName}
                      {g.external ? <Badge className="ml-2">External</Badge> : null}
                    </p>
                    <p className="text-sm text-muted">
                      {g.email ?? "No email"} · {g.role}
                      {g.revisionNumber ? ` · version ${g.revisionNumber} only` : ""} · since {formatDate(g.createdAt)}
                    </p>
                  </div>
                  <ActionForm action={revokeGrantAction} submitLabel="Revoke" submitVariant="ghost" submitSize="sm" submitAriaLabel={`Revoke ${g.role} access for ${g.displayName}`} quietSuccess>
                    {hidden}
                    <input type="hidden" name="grantId" value={g.grantId} />
                  </ActionForm>
                </li>
              ))}
            </ul>
            <div className="mt-5 rounded-lg border border-dashed border-line-strong p-4">
              <h3 className="font-medium text-ink">Give someone access</h3>
              <ActionForm action={grantAccessAction} submitLabel="Grant access" resetOnSuccess className="mt-3">
                {hidden}
                <Input id="grant-email" name="email" type="email" label="Email" required autoComplete="off" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    id="grant-role"
                    name="role"
                    label="Role"
                    defaultValue="reader"
                    options={[
                      { value: "reader", label: "Reader" },
                      { value: "editor", label: "Editor (company members only)" },
                      { value: "publisher", label: "Publisher (company members only)" },
                    ]}
                  />
                  <Select
                    id="grant-revision"
                    name="revisionNumber"
                    label="Limit to one version (readers)"
                    defaultValue=""
                    options={[{ value: "", label: "All published versions" }, ...revisionOptions]}
                  />
                </div>
              </ActionForm>
            </div>
          </section>

          {/* Share links */}
          <section aria-labelledby="links-title" className="border-t border-line pt-10">
            <h2 id="links-title" className="font-serif text-title text-ink">
              Share links
            </h2>
            <p className="mt-1 text-muted">
              A link only helps people find the briefing: opening it requires signing in, and the reader must already be in the audience or hold
              a grant. <strong className="font-medium text-ink">Revoking a link does not remove anyone&apos;s direct access.</strong>
            </p>
            <ActionForm action={createShareLinkAction} submitLabel="Create link" className="mt-4">
              {hidden}
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  id="link-pinned"
                  name="pinned"
                  label="Opens"
                  defaultValue=""
                  options={[{ value: "", label: "The latest version (stable)" }, ...revisionOptions.map((o) => ({ value: o.value, label: `${o.label} only (pinned)` }))]}
                />
                <Input id="link-expiry" name="expiresAt" type="date" label="Expires (optional)" />
              </div>
            </ActionForm>
            {links.length ? (
              <ul className="mt-6 flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
                {links.map((l) => (
                  <li key={l.shareLinkId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="flex items-center gap-2 text-ink">
                        {l.pinnedRevisionNumber ? `Pinned to version ${l.pinnedRevisionNumber}` : "Stable (latest version)"}
                        <Badge tone={LINK_STATE[l.state]}>{l.state[0]!.toUpperCase() + l.state.slice(1)}</Badge>
                      </p>
                      <p className="text-sm text-muted">
                        Created {formatDateTime(l.createdAt)}
                        {l.expiresAt ? ` · expires ${formatDateTime(l.expiresAt)}` : " · no expiry"}
                        {l.revokedAt ? ` · revoked ${formatDateTime(l.revokedAt)}` : ""}
                      </p>
                    </div>
                    {l.state === "active" ? (
                      <ActionForm action={revokeShareLinkAction} submitLabel="Revoke link" submitVariant="ghost" submitSize="sm" quietSuccess>
                        {hidden}
                        <input type="hidden" name="shareLinkId" value={l.shareLinkId} />
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted">No share links yet.</p>
            )}
            <p className="mt-3 text-sm text-muted">Link addresses are shown only once, when created.</p>
          </section>
        </div>
      </AuthorPage>
    </>
  );
}
