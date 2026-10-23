import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isDomainError, resolveShareLink } from "@cerebro/domain";
import { BriefingUnavailable, type UnavailableKind } from "@/components/briefing/briefing-state";
import { briefingPaths } from "@/lib/paths";
import { MinimalShell } from "@/components/chrome";
import { UserMenu } from "@/components/workspace/top-bar";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared briefing", referrer: "no-referrer" };

/**
 * Share link resolution (D04): sign-in required; the link is a locator, not
 * authorization. Stable links open the latest version, pinned links exactly
 * one. Every failure shows a neutral state without the briefing's title.
 */
export default async function ShareLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/s/${encodeURIComponent(token)}`);
  let target: string | null = null;
  let kind: UnavailableKind = "not_found";
  try {
    const res = await resolveShareLink(await getDb(), { token, userId: user.userId });
    target = briefingPaths.revision(res.orgSlug, res.briefingSlug, res.revisionNumber ?? null);
  } catch (err) {
    if (!isDomainError(err)) throw err;
    if (err.code === "unauthenticated") redirect(`/sign-in?next=${encodeURIComponent(`/s/${token}`)}`);
    const reason = (err.details as { reason?: string } | undefined)?.reason;
    kind = reason === "expired" || reason === "revoked" || reason === "withdrawn" ? reason : "not_found";
  }
  if (target) redirect(target);
  return (
    <MinimalShell actions={<UserMenu name={user.name} email={user.email} />}>
      <BriefingUnavailable kind={kind} />
    </MinimalShell>
  );
}
