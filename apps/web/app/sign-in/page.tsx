import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClerkProvider, SignIn } from "@clerk/nextjs";
import { MinimalShell } from "@/components/chrome";
import { getSignInState, safeNextPath, type SignInState } from "@/lib/auth";
import { authMode } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

/** Why a Clerk-authenticated person has no Cerebro account yet (never reveals other accounts). */
function notice(reason: SignInState["reason"]): string | null {
  switch (reason) {
    case "email_unverified":
      return "Verify your email address with the sign-in provider, then try again.";
    case "not_invited":
      return "There is no Cerebro account or pending invitation for this email address. Ask a company admin to invite you, then open the invitation link.";
    case "identity_conflict":
      return "This email address is already linked to a different sign-in. Sign in with that account, or contact your company admin.";
    case "no_email":
    case "missing_issuer":
      return "Your sign-in did not include a verified email address. Contact your company admin.";
    default:
      return null;
  }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const dest = safeNextPath(next);
  if (authMode() === "dev") {
    redirect(`/dev/sign-in${dest !== "/" ? `?next=${encodeURIComponent(dest)}` : ""}`);
  }
  // Clerk (D08). A Clerk session without a Cerebro account lands here again;
  // say why rather than looping.
  const state = await getSignInState();
  if (state.user) redirect(dest);
  const message = notice(state.reason);
  return (
    <ClerkProvider>
      <MinimalShell>
        <h1 className="mb-6 font-serif text-headline text-ink">Sign in to Cerebro</h1>
        {message ? (
          <p role="status" className="mb-6 text-sm text-ink">
            {message}
          </p>
        ) : null}
        <SignIn routing="hash" withSignUp forceRedirectUrl={dest} signUpForceRedirectUrl={dest} />
      </MinimalShell>
    </ClerkProvider>
  );
}
