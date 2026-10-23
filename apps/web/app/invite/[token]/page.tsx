import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/action-form";
import { MinimalShell } from "@/components/chrome";
import { UserMenu } from "@/components/workspace/top-bar";
import { requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";
import { acceptInvitationAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invitation", robots: { index: false }, referrer: "no-referrer" };

/**
 * Invitation landing. Accepting is an explicit POST (never on GET, so link
 * previews and prefetches cannot consume the invitation). Nothing about the
 * company or briefing is disclosed before acceptance.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(paths.invite(decodeURIComponent(token)));
  return (
    <MinimalShell actions={<UserMenu name={user.name} email={user.email} />}>
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Invitation</p>
      <h1 className="mt-3 font-serif text-headline text-ink">You&apos;ve been invited to Cerebro</h1>
      <p className="mt-3 text-muted">
        Accept to join as <strong className="text-ink">{user.name}</strong> ({user.email}). Invitations only work for the
        email address they were sent to.
      </p>
      <ActionForm action={acceptInvitationAction} submitLabel="Accept invitation" pendingLabel="Accepting…" className="mt-6">
        <input type="hidden" name="token" value={decodeURIComponent(token)} />
      </ActionForm>
    </MinimalShell>
  );
}
