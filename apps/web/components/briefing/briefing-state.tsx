import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@cerebro/ui";

/**
 * Full-page states for briefings and links that cannot be shown. The copy
 * never includes the briefing's title, summary or excerpts, so it is safe to
 * show to anyone who reaches the URL.
 */
export type UnavailableKind = "withdrawn" | "expired" | "revoked" | "not_found" | "unpublished";

const COPY: Record<UnavailableKind, { eyebrow: string; title: string; body: string }> = {
  withdrawn: {
    eyebrow: "Withdrawn",
    title: "This briefing has been withdrawn",
    body: "The author withdrew this publication, so it is no longer available to read. If you need it, contact the author.",
  },
  expired: {
    eyebrow: "Link expired",
    title: "This link has expired",
    body: "The link you followed is no longer active. Ask the person who shared it for a new link.",
  },
  revoked: {
    eyebrow: "Link unavailable",
    title: "This link is no longer available",
    body: "The link you followed has been turned off. Ask the person who shared it for access.",
  },
  not_found: {
    eyebrow: "Not available",
    title: "We couldn't open this",
    body: "It may have moved or been withdrawn, or you may not have access to it. If someone shared it with you, ask them to check that you have been given access.",
  },
  unpublished: {
    eyebrow: "Draft",
    title: "Not published yet",
    body: "This briefing has no published version, so readers can't see it. Only you and other collaborators can see the draft.",
  },
};

export function BriefingUnavailable({ kind, children, homeHref = "/" }: { kind: UnavailableKind; children?: ReactNode; homeHref?: string }) {
  const c = COPY[kind];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start px-4 py-20 sm:px-6">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">{c.eyebrow}</p>
      <h1 className="mt-3 font-serif text-headline text-ink">{c.title}</h1>
      <p className="mt-3 text-muted">{c.body}</p>
      {children ? <div className="mt-6 flex flex-wrap gap-2">{children}</div> : null}
      {!children ? (
        <Link href={homeHref} className={buttonClasses({ variant: "secondary", className: "mt-6" })}>
          Go to your workspace
        </Link>
      ) : null}
    </div>
  );
}
