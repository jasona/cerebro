import { Badge, Card } from "@cerebro/ui";
import type { MemberDTO, OrgTree } from "@cerebro/domain";
import {
  addDepartmentMemberAction,
  addTeamMemberAction,
  changeRoleAction,
  removeDepartmentMemberAction,
  removeMembershipAction,
  removeTeamMemberAction,
} from "@/app/c/[company]/admin/actions";
import { ActionForm } from "@/components/forms/action-form";
import { Avatar } from "@/components/workspace/top-bar";
import { ConfirmDisclosure, Hidden } from "./confirm";

const selectClass = "rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-fg";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function MembersSection({
  company,
  members,
  tree,
  viewerUserId,
  viewerIsOwner,
}: {
  company: string;
  members: MemberDTO[];
  tree: OrgTree;
  viewerUserId: string;
  viewerIsOwner: boolean;
}) {
  const departments = tree.departments.filter((d) => !d.archivedAt);
  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-4">
      <h2 id="members-heading" className="sr-only">
        Members
      </h2>
      <p className="text-sm text-muted">
        Administration manages structure and membership only. It does not grant access to drafts, restricted briefs,
        sources, or private questions.
      </p>
      <ul className="flex flex-col gap-3">
        {members.map((m) => {
          const teamIds = new Set(m.teams.map((t) => t.teamId));
          const deptIds = new Set(m.departments.map((d) => d.departmentId));
          const self = m.userId === viewerUserId;
          return (
            <li key={m.membershipId}>
              <Card as="article" aria-labelledby={`member-${m.userId}`}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar name={m.displayName} />
                    <div>
                      <h3 id={`member-${m.userId}`} className="font-medium text-ink">
                        {m.displayName} {self ? <span className="text-sm font-normal text-muted">(you)</span> : null}
                      </h3>
                      <p className="text-sm text-muted">{m.email}</p>
                    </div>
                    <Badge tone={m.role === "member" ? "neutral" : "accent"}>{ROLE_LABEL[m.role]}</Badge>
                    {m.status !== "active" ? <Badge tone="warning">{m.status}</Badge> : null}
                  </div>
                  <ActionForm action={changeRoleAction} submitLabel="Change role" submitVariant="secondary" submitSize="sm" inline>
                    <Hidden fields={{ company, userId: m.userId }} />
                    <label htmlFor={`role-${m.userId}`} className="sr-only">
                      Role for {m.displayName}
                    </label>
                    <select id={`role-${m.userId}`} name="role" defaultValue={m.role} className={selectClass}>
                      <option value="member">Member</option>
                      <option value="admin" disabled={!viewerIsOwner}>
                        Admin{viewerIsOwner ? "" : " (owner only)"}
                      </option>
                      <option value="owner" disabled={!viewerIsOwner}>
                        Owner{viewerIsOwner ? "" : " (owner only)"}
                      </option>
                    </select>
                  </ActionForm>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-xs font-medium tracking-wider text-muted uppercase">Teams</h4>
                    {m.teams.length === 0 ? <p className="mt-1 text-sm text-muted">No teams.</p> : null}
                    <ul className="mt-2 flex flex-col gap-1">
                      {m.teams.map((t) => (
                        <li key={t.teamId} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            {t.departmentName} / {t.name}
                          </span>
                          <ActionForm
                            action={removeTeamMemberAction}
                            submitLabel="Remove"
                            submitAriaLabel={`Remove ${m.displayName} from ${t.name}`}
                            submitVariant="ghost"
                            submitSize="sm"
                            quietSuccess
                          >
                            <Hidden fields={{ company, userId: m.userId, teamId: t.teamId }} />
                          </ActionForm>
                        </li>
                      ))}
                    </ul>
                    <ActionForm action={addTeamMemberAction} submitLabel="Add to team" submitVariant="secondary" submitSize="sm" inline className="mt-2">
                      <Hidden fields={{ company, userId: m.userId }} />
                      <label htmlFor={`add-team-${m.userId}`} className="sr-only">
                        Add {m.displayName} to team
                      </label>
                      <select id={`add-team-${m.userId}`} name="teamId" required className={selectClass} defaultValue="">
                        <option value="" disabled>
                          Choose a team
                        </option>
                        {departments.map((d) => (
                          <optgroup key={d.id} label={d.name}>
                            {d.teams
                              .filter((t) => !t.archivedAt && !teamIds.has(t.id))
                              .map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    </ActionForm>
                  </div>
                  <div>
                    <h4 className="text-xs font-medium tracking-wider text-muted uppercase">Explicit departments</h4>
                    {m.departments.length === 0 ? <p className="mt-1 text-sm text-muted">None (team membership still counts).</p> : null}
                    <ul className="mt-2 flex flex-col gap-1">
                      {m.departments.map((d) => (
                        <li key={d.departmentId} className="flex items-center justify-between gap-2 text-sm">
                          <span>{d.name}</span>
                          <ActionForm
                            action={removeDepartmentMemberAction}
                            submitLabel="Remove"
                            submitAriaLabel={`Remove ${m.displayName} from ${d.name}`}
                            submitVariant="ghost"
                            submitSize="sm"
                            quietSuccess
                          >
                            <Hidden fields={{ company, userId: m.userId, departmentId: d.departmentId }} />
                          </ActionForm>
                        </li>
                      ))}
                    </ul>
                    <ActionForm
                      action={addDepartmentMemberAction}
                      submitLabel="Add to department"
                      submitVariant="secondary"
                      submitSize="sm"
                      inline
                      className="mt-2"
                    >
                      <Hidden fields={{ company, userId: m.userId }} />
                      <label htmlFor={`add-dept-${m.userId}`} className="sr-only">
                        Add {m.displayName} to department
                      </label>
                      <select id={`add-dept-${m.userId}`} name="departmentId" required className={selectClass} defaultValue="">
                        <option value="" disabled>
                          Choose a department
                        </option>
                        {departments
                          .filter((d) => !deptIds.has(d.id))
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                      </select>
                    </ActionForm>
                  </div>
                </div>

                {!self ? (
                  <div className="mt-4 border-t border-line pt-3">
                    <ConfirmDisclosure label="Remove from company">
                      <p className="mb-3 max-w-md text-sm">
                        Remove <strong>{m.displayName}</strong> from the company? Their team and department access ends, and
                        company-visible briefs become unavailable to them on their next request.
                      </p>
                      <ActionForm action={removeMembershipAction} submitLabel="Remove membership" submitVariant="danger" submitSize="sm">
                        <Hidden fields={{ company, userId: m.userId }} />
                      </ActionForm>
                    </ConfirmDisclosure>
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
