import Link from "next/link";
import { cn, focusRing } from "@cerebro/ui";
import { initials } from "@/lib/format";
import { signOutAction } from "@/lib/auth-actions";
import { SearchIcon } from "../icons";
import { ThemeSwitch } from "../theme-switch";

/** Top-bar search: plain GET to the company library with ?q=. */
export function SearchBox({ companySlug, defaultValue }: { companySlug: string; defaultValue?: string }) {
  return (
    <form role="search" action={`/c/${encodeURIComponent(companySlug)}`} method="get" className="relative hidden md:block">
      <label htmlFor="topbar-search" className="sr-only">
        Search briefs
      </label>
      <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <input
        id="topbar-search"
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="Search briefs"
        className={cn("h-9 w-56 rounded-md border border-line-strong bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-muted", focusRing)}
      />
    </form>
  );
}

/** Avatar with initials; decorative when a visible name is next to it. */
export function Avatar({ name, size = "md", decorative = true }: { name: string; size?: "sm" | "md"; decorative?: boolean }) {
  return (
    <span
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : name}
      role={decorative ? undefined : "img"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-medium text-accent-ink",
        size === "sm" ? "size-8 text-xs" : "size-9 text-sm",
      )}
    >
      {initials(name)}
    </span>
  );
}

/** User menu: native disclosure with profile, theme, settings and sign-out. */
export function UserMenu({ name, email, companySlug }: { name: string; email: string; companySlug?: string }) {
  return (
    <details className="group relative">
      <summary className={cn("flex cursor-pointer items-center rounded-full", focusRing)}>
        <Avatar name={name} />
        <span className="sr-only">Account menu for {name}</span>
      </summary>
      <div className="absolute top-full right-0 z-40 mt-2 w-64 rounded-lg border border-line bg-surface p-1 shadow-raised">
        <div className="border-b border-line px-3 py-2.5">
          <p className="truncate font-medium text-ink">{name}</p>
          <p className="truncate text-sm text-muted">{email}</p>
        </div>
        <ThemeSwitch className="border-b border-line px-3 py-2.5" />
        <ul className="py-1">
          {companySlug ? (
            <li>
              <Link
                href={`/c/${encodeURIComponent(companySlug)}/settings`}
                className={cn("block rounded-md px-3 py-2 text-sm hover:bg-subtle", focusRing)}
              >
                Settings and connections
              </Link>
            </li>
          ) : null}
          <li>
            <form action={signOutAction}>
              <button type="submit" className={cn("block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-subtle", focusRing)}>
                Sign out
              </button>
            </form>
          </li>
        </ul>
      </div>
    </details>
  );
}
