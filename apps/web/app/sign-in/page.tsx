import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClerkProvider, SignIn } from "@clerk/nextjs";
import { MinimalShell } from "@/components/chrome";
import { getSessionUser, safeNextPath } from "@/lib/auth";
import { authMode } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const dest = safeNextPath(next);
  if (authMode() === "dev") {
    redirect(`/dev/sign-in${dest !== "/" ? `?next=${encodeURIComponent(dest)}` : ""}`);
  }
  // Clerk adapter (stub). A Clerk session without a provisioned Cerebro user
  // lands here again; say so rather than looping.
  const user = await getSessionUser();
  if (user) redirect(dest);
  return (
    <ClerkProvider>
      <MinimalShell>
        <h1 className="mb-6 font-serif text-headline text-ink">Sign in to Cerebro</h1>
        <SignIn routing="hash" forceRedirectUrl={dest} />
        <p className="mt-6 text-sm text-muted">
          If you are already signed in and still see this page, your account has not been added to a Cerebro company yet.
        </p>
      </MinimalShell>
    </ClerkProvider>
  );
}
