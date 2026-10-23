"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn, focusRing } from "@cerebro/ui";

export interface NavLinkProps {
  href: string;
  children: ReactNode;
  icon?: ReactNode;
  /** Match nested paths as current (default: exact match only). */
  matchPrefix?: boolean;
  className?: string;
}

/** Rail link with aria-current for the active route. */
export function NavLink({ href, children, icon, matchPrefix, className }: NavLinkProps) {
  const pathname = usePathname();
  const active = pathname === href || (matchPrefix === true && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-9 items-center gap-3 rounded-md px-3 py-1.5 text-[0.9375rem] text-fg hover:bg-subtle hover:text-ink",
        active && "bg-accent-soft font-medium text-accent-ink hover:bg-accent-soft",
        focusRing,
        className,
      )}
    >
      {icon ? <span className={cn("shrink-0 text-muted", active && "text-accent-ink")}>{icon}</span> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}
