import Link from "next/link";
import { Badge, buttonClasses, Card, Input } from "@cerebro/ui";
import type { OrgTree, TeamReparentImpact } from "@cerebro/domain";
import {
  archiveDepartmentAction,
  archiveTeamAction,
  createDepartmentAction,
  createTeamAction,
  renameDepartmentAction,
  renameTeamAction,
  reparentTeamAction,
} from "@/app/c/[company]/admin/actions";
import { ActionForm } from "@/components/forms/action-form";
import { plural } from "@/lib/format";
import { paths } from "@/lib/paths";
import { ConfirmDisclosure, Hidden } from "./confirm";

export interface ReparentPreview {
  teamName: string;
  fromName: string;
  toName: string;
  impact: TeamReparentImpact;
}

export function StructureSection({ company, tree, preview, previewError }: { company: string; tree: OrgTree; preview?: ReparentPreview | null; previewError?: string | null }) {
  const active = tree.departments.filter((d) => !d.archivedAt);
  const archived = tree.departments.filter((d) => d.archivedAt);
  return (
    <section aria-labelledby="structure-heading" className="flex flex-col gap-6">
      <h2 id="structure-heading" className="sr-only">
        Departments and teams
      </h2>

      {previewError ? (
        <p role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
          {previewError}
        </p>
      ) : null}
      {preview ? <ReparentPreviewPanel company={company} preview={preview} /> : null}

      <Card>
        <h3 className="font-serif text-title text-ink">New department</h3>
        <ActionForm action={createDepartmentAction} submitLabel="Create department" resetOnSuccess inline className="mt-3">
          <Hidden fields={{ company }} />
          <Input id="new-dept-name" name="name" label="Department name" required maxLength={120} fieldClassName="min-w-64 flex-1" />
        </ActionForm>
      </Card>

      {active.length === 0 ? <p className="text-muted">No departments yet. Create the first one above.</p> : null}

      <ul className="flex flex-col gap-4">
        {active.map((d) => (
          <li key={d.id}>
            <Card as="article" aria-labelledby={`dept-${d.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id={`dept-${d.id}`} className="font-serif text-title text-ink">
                    {d.name}
                  </h3>
                  <p className="text-sm text-muted">
                    {plural(d.teams.filter((t) => !t.archivedAt).length, "team")} · {plural(d.memberCount, "person", "people")} ·{" "}
                    <Link className="text-accent underline-offset-2 hover:underline" href={paths.department(company, d.slug)}>
                      View department
                    </Link>
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <ConfirmDisclosure label="Rename" tone="neutral">
                    <ActionForm action={renameDepartmentAction} submitLabel="Save name" inline>
                      <Hidden fields={{ company, departmentId: d.id }} />
                      <Input id={`rename-dept-${d.id}`} name="name" label="New name" defaultValue={d.name} required maxLength={120} />
                    </ActionForm>
                  </ConfirmDisclosure>
                  <ConfirmDisclosure label="Archive">
                    <p className="mb-3 max-w-sm text-sm">
                      Archive <strong>{d.name}</strong>? It disappears from navigation. Briefings homed here keep their
                      provenance and audience.
                    </p>
                    <ActionForm action={archiveDepartmentAction} submitLabel="Archive department" submitVariant="danger" submitSize="sm">
                      <Hidden fields={{ company, departmentId: d.id }} />
                    </ActionForm>
                  </ConfirmDisclosure>
                </div>
              </div>

              <h4 className="mt-5 text-xs font-medium tracking-wider text-muted uppercase">Teams</h4>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {d.teams
                  .filter((t) => !t.archivedAt)
                  .map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <p className="font-medium text-ink">{t.name}</p>
                        <p className="text-sm text-muted">{plural(t.memberCount, "member")}</p>
                      </div>
                      <div className="flex flex-wrap items-start gap-2">
                        <ConfirmDisclosure label="Rename" tone="neutral">
                          <ActionForm action={renameTeamAction} submitLabel="Save name" inline>
                            <Hidden fields={{ company, teamId: t.id }} />
                            <Input id={`rename-team-${t.id}`} name="name" label="New name" defaultValue={t.name} required maxLength={120} />
                          </ActionForm>
                        </ConfirmDisclosure>
                        {active.length > 1 ? (
                          <ConfirmDisclosure label="Move" tone="neutral">
                            {/* Step 1: GET to the same page to render the impact preview. */}
                            <form method="get" action={paths.admin(company)} className="flex flex-wrap items-end gap-2">
                              <input type="hidden" name="tab" value="structure" />
                              <input type="hidden" name="reparent" value={t.id} />
                              <div className="flex flex-col gap-1.5">
                                <label htmlFor={`move-${t.id}`} className="text-sm font-medium text-ink">
                                  Move {t.name} to
                                </label>
                                <select
                                  id={`move-${t.id}`}
                                  name="to"
                                  required
                                  className="rounded-md border border-line-strong bg-surface px-3 py-2 text-base"
                                >
                                  {active
                                    .filter((o) => o.id !== d.id)
                                    .map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.name}
                                      </option>
                                    ))}
                                </select>
                              </div>
                              <button type="submit" className={buttonClasses({ variant: "secondary" })}>
                                Preview impact
                              </button>
                            </form>
                          </ConfirmDisclosure>
                        ) : null}
                        <ConfirmDisclosure label="Archive">
                          <p className="mb-3 max-w-sm text-sm">
                            Archive <strong>{t.name}</strong>? Members lose this team&apos;s audience access; briefings homed here
                            keep their provenance.
                          </p>
                          <ActionForm action={archiveTeamAction} submitLabel="Archive team" submitVariant="danger" submitSize="sm">
                            <Hidden fields={{ company, teamId: t.id }} />
                          </ActionForm>
                        </ConfirmDisclosure>
                      </div>
                    </li>
                  ))}
              </ul>
              <ActionForm action={createTeamAction} submitLabel="Add team" submitVariant="secondary" resetOnSuccess inline className="mt-4">
                <Hidden fields={{ company, departmentId: d.id }} />
                <Input id={`new-team-${d.id}`} name="name" label={`New team in ${d.name}`} required maxLength={120} fieldClassName="min-w-64 flex-1" />
              </ActionForm>
            </Card>
          </li>
        ))}
      </ul>

      {archived.length ? (
        <div>
          <h3 className="text-sm font-medium text-muted">Archived departments</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {archived.map((d) => (
              <li key={d.id}>
                <Badge>{d.name}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PeopleList({ people, empty }: { people: { userId: string; displayName: string }[]; empty: string }) {
  if (people.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {people.map((p) => (
        <li key={p.userId}>
          <Badge>{p.displayName}</Badge>
        </li>
      ))}
    </ul>
  );
}

function ReparentPreviewPanel({ company, preview }: { company: string; preview: ReparentPreview }) {
  const { impact } = preview;
  return (
    <Card tone="subtle" as="section" aria-labelledby="reparent-heading" className="border-warning/40">
      <p className="text-xs font-medium tracking-wider text-warning uppercase">Access-affecting change · review before confirming</p>
      <h3 id="reparent-heading" className="mt-2 font-serif text-title text-ink">
        Move {preview.teamName} from {preview.fromName} to {preview.toName}
      </h3>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <dt className="text-sm font-medium text-ink">Lose derived {preview.fromName} membership</dt>
          <dd className="mt-1.5">
            <PeopleList people={impact.usersLosingDepartmentAccess} empty="No one." />
          </dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Gain derived {preview.toName} membership</dt>
          <dd className="mt-1.5">
            <PeopleList people={impact.usersGainingDepartmentAccess} empty="No one." />
          </dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Department-audience briefings whose readership changes</dt>
          <dd className="mt-1 text-sm">
            {plural(impact.departmentAudienceBriefings.count, "briefing")}
            <span className="block text-muted">Titles are not shown here; admins see only what they can read.</span>
          </dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Briefings homed at this team</dt>
          <dd className="mt-1 text-sm">
            {plural(impact.homedBriefings.count, "briefing")} move with the team. Their audience does not change.
          </dd>
        </div>
      </dl>
      <div className="mt-5 flex flex-wrap items-start gap-3">
        <ActionForm action={reparentTeamAction} submitLabel={`Move ${preview.teamName}`} pendingLabel="Moving…">
          <Hidden fields={{ company, teamId: impact.teamId, newDepartmentId: impact.toDepartmentId }} />
        </ActionForm>
        <Link href={paths.admin(company, { tab: "structure" })} className={buttonClasses({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </Card>
  );
}
