import { redirect } from "next/navigation";
import { listMyCompanies } from "@cerebro/domain";
import { MinimalShell } from "@/components/chrome";
import { UserMenu } from "@/components/workspace/top-bar";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/context";

export const dynamic = "force-dynamic";

/** Entry point: the user's first company library, or sign-in. */
export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const companies = await listMyCompanies(await getDb(), user.userId);
  const first = companies[0];
  if (first) redirect(`/c/${encodeURIComponent(first.slug)}`);

  // Signed in without a company membership (e.g. an external reader).
  return (
    <MinimalShell actions={<UserMenu name={user.name} email={user.email} />}>
      <h1 className="font-serif text-headline text-ink">No company workspace yet</h1>
      <p className="mt-3 text-muted">
        You are signed in as {user.name}, but you are not a member of a company in Cerebro. If someone shared a briefing
        with you, open the link they sent. To join a company, ask an administrator for an invitation.
      </p>
    </MinimalShell>
  );
}
