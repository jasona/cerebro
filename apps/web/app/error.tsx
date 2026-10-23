"use client";

import { useEffect } from "react";
import { Button } from "@cerebro/ui";

/**
 * Route error boundary. Server error messages are not shown (production
 * strips them anyway); the digest helps correlate with server logs.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged in the browser console only; no payloads.
    console.error("Route error", error.digest ?? "");
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start px-4 py-20 sm:px-6">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Something went wrong</p>
      <h1 className="mt-3 font-serif text-headline text-ink">This page couldn&apos;t load</h1>
      <p className="mt-3 text-muted">
        Nothing you were working on has been lost. Try again; if the problem continues, reload the page.
      </p>
      {error.digest ? <p className="mt-2 font-mono text-xs text-muted">Reference: {error.digest}</p> : null}
      <Button className="mt-6" variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
