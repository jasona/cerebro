import { Badge, Card, Input } from "@cerebro/ui";
import type { InvitationDTO } from "@cerebro/domain";
import { createInvitationAction, revokeInvitationAction } from "@/app/c/[company]/admin/actions";
import { ActionForm } from "@/components/forms/action-form";
import { formatDate } from "@/lib/format";
import { Hidden } from "./confirm";

const STATUS_TONE = { pending: "info", accepted: "success", revoked: "neutral", expired: "warning" } as const;

export function InvitationsSection({ company, invitations, viewerIsOwner }: { company: string; invitations: InvitationDTO[]; viewerIsOwner: boolean }) {
  const membership = invitations.filter((i) => i.kind === "membership");
  return (
    <section aria-labelledby="invitations-heading" className="flex flex-col gap-6">
      <h2 id="invitations-heading" className="sr-only">
        Invitations
      </h2>
      <Card>
        <h3 className="font-serif text-title text-ink">Invite someone to the company</h3>
        <p className="mt-1 text-sm text-muted">
          Cerebro does not send email yet. You will get a one-time link to send yourself. It only works for the invited
          email address.
        </p>
        <ActionForm action={createInvitationAction} submitLabel="Create invitation" resetOnSuccess className="mt-4">
          <Hidden fields={{ company }} />
          <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
            <Input id="invite-email" name="email" type="email" label="Email address" autoComplete="off" required maxLength={320} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invite-role" className="text-sm font-medium text-ink">
                Company role
              </label>
              <select id="invite-role" name="role" defaultValue="member" className="rounded-md border border-line-strong bg-surface px-3 py-2 text-base">
                <option value="member">Member</option>
                <option value="admin" disabled={!viewerIsOwner}>
                  Admin{viewerIsOwner ? "" : " (owner only)"}
                </option>
              </select>
            </div>
          </div>
        </ActionForm>
      </Card>

      <div>
        <h3 className="font-serif text-title text-ink">Company invitations</h3>
        {membership.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No invitations yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Company invitations</caption>
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Role</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Expires</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {membership.map((i) => (
                  <tr key={i.id}>
                    <td className="py-3 pr-4 text-ink">{i.email}</td>
                    <td className="py-3 pr-4 capitalize">{i.role ?? "member"}</td>
                    <td className="py-3 pr-4">
                      <Badge tone={STATUS_TONE[i.status]} className="capitalize">{i.status}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-muted">{formatDate(i.expiresAt)}</td>
                    <td className="py-3 text-right">
                      {i.status === "pending" ? (
                        <ActionForm
                          action={revokeInvitationAction}
                          submitLabel="Revoke"
                          submitAriaLabel={`Revoke invitation for ${i.email}`}
                          submitVariant="ghost"
                          submitSize="sm"
                          quietSuccess
                        >
                          <Hidden fields={{ company, invitationId: i.id }} />
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
