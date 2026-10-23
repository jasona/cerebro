import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClerkProvider, SignOutButton } from "@clerk/nextjs";
import { buttonClasses } from "@cerebro/ui";
import { MinimalShell } from "@/components/chrome";
import { authMode } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign out" };

/** Clerk sign-out needs the client SDK; dev sign-out is a server action. */
export default function SignOutPage() {
  if (authMode() === "dev") redirect("/dev/sign-in");
  return (
    <ClerkProvider>
      <MinimalShell>
        <h1 className="mb-6 font-serif text-headline text-ink">Sign out</h1>
        <SignOutButton redirectUrl="/sign-in">
          <button type="button" className={buttonClasses()}>
            Sign out of Cerebro
          </button>
        </SignOutButton>
      </MinimalShell>
    </ClerkProvider>
  );
}
