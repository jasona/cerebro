import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card } from "@cerebro/ui";
import { MinimalShell } from "@/components/chrome";
import { getSessionUser, listDevUsers, safeNextPath } from "@/lib/auth";
import { devSignInAction, signOutAction } from "@/lib/auth-actions";
import { authMode } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Development sign-in", robots: { index: false } };

export default async function DevSignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  if (authMode() !== "dev") notFound();
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  const [users, current] = await Promise.all([listDevUsers(), getSessionUser()]);

  return (
    <MinimalShell>
      <div className="flex flex-col gap-6">
        <div>
          <Badge tone="warning">Development only</Badge>
          <h1 className="mt-3 font-serif text-headline text-ink">Sign in as a seeded user</h1>
          <p className="mt-2 text-muted">
            This picker exists only when <code className="font-mono text-sm">AUTH_MODE=dev</code>. It is not a production
            sign-in.
          </p>
        </div>

        {sp.error ? (
          <p role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
            That user does not exist. Run <code className="font-mono">npm run db:seed</code> and try again.
          </p>
        ) : null}

        {current ? (
          <Card tone="subtle" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Signed in as <strong className="text-ink">{current.name}</strong> ({current.email})
            </p>
            <form action={signOutAction}>
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          </Card>
        ) : null}

        {users.length === 0 ? (
          <Card>
            <p className="text-sm">
              No development users found. Run <code className="font-mono">npm run db:reset</code> from the repository root.
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Development users">
            {users.map((u) => (
              <li key={u.authSubject}>
                <form action={devSignInAction}>
                  <input type="hidden" name="subject" value={u.authSubject} />
                  <input type="hidden" name="next" value={next} />
                  <button
                    type="submit"
                    className="flex w-full items-center justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3 text-left hover:border-line-strong hover:bg-subtle"
                  >
                    <span>
                      <span className="block font-medium text-ink">{u.name}</span>
                      <span className="block text-sm text-muted">{u.email}</span>
                    </span>
                    <span className="text-sm font-medium text-accent">
                      Sign in<span className="sr-only"> as {u.name}</span>
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </MinimalShell>
  );
}
