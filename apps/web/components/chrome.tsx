import Link from "next/link";
import type { ReactNode } from "react";
import { cn, focusRing } from "@cerebro/ui";
import { CerebroMark } from "./icons";

/** First focusable element on every page; targets `#main`. */
export function SkipLink({ target = "main" }: { target?: string }) {
  return (
    <a
      href={`#${target}`}
      className={cn(
        "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-raised",
        focusRing,
      )}
    >
      Skip to main content
    </a>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5 rounded-md text-accent", focusRing, className)}>
      <CerebroMark size={26} />
      <span className="font-serif text-[1.375rem] font-semibold tracking-tight text-ink">cerebro</span>
    </Link>
  );
}

/**
 * Chrome for pages without workspace navigation: sign-in, invitations,
 * share links (`/s/**`) and external readers who hold only a briefing grant
 * (they get no company directory access, D04).
 *
 * `full`: no width cap or padding on `<main>`, so the page lays itself out
 * edge to edge (the reader's outline / content / explore columns). Takes
 * precedence over `wide`.
 */
export function MinimalShell({ children, actions, wide, full }: { children: ReactNode; actions?: ReactNode; wide?: boolean; full?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className={cn("border-b border-line bg-paper", full && "sticky top-0 z-30")}>
        <div className={cn("flex h-16 items-center justify-between gap-4 px-4 sm:px-6", full ? "lg:px-8" : "mx-auto max-w-6xl")}>
          <Logo />
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className={cn("w-full flex-1 outline-none", full ? "" : cn("mx-auto px-4 py-10 sm:px-6", wide ? "max-w-6xl" : "max-w-xl"))}
      >
        {children}
      </main>
    </div>
  );
}
