import Link from "next/link";
import type { ReactNode } from "react";
import type { Capability } from "@cerebro/domain";
import { cn, focusRing } from "@cerebro/ui";
import { briefingPaths } from "@/lib/paths";
import { PageBreadcrumb } from "../workspace/page-breadcrumb";
import type { Crumb } from "../workspace/shell-context";

export type AuthorView = "read" | "edit" | "preview" | "history" | "engagement" | "access";

interface NavItem {
  key: AuthorView;
  label: string;
  href: string;
  show: boolean;
}

export function authorNavItems(company: string, briefing: string, caps: readonly Capability[], published: boolean): NavItem[] {
  const has = (c: Capability) => caps.includes(c);
  return [
    { key: "read", label: published ? "Read" : "Reader", href: briefingPaths.reader(company, briefing), show: true },
    { key: "edit", label: "Edit", href: briefingPaths.edit(company, briefing), show: has("edit") },
    { key: "preview", label: "Preview & publish", href: briefingPaths.preview(company, briefing), show: has("publish") },
    { key: "history", label: "History", href: briefingPaths.history(company, briefing), show: has("read") },
    { key: "engagement", label: "Engagement", href: briefingPaths.engagement(company, briefing), show: has("view_engagement") },
    { key: "access", label: "Access", href: briefingPaths.access(company, briefing), show: has("manage_access") },
  ];
}

/** True when the viewer holds any author capability (drives whether author actions appear at all). */
export const isCollaborator = (caps: readonly Capability[]) =>
  caps.some((c) => c === "edit" || c === "publish" || c === "manage_access" || c === "view_engagement" || c === "withdraw");

/**
 * Briefing-level navigation between the reader and author views. Only views
 * the viewer's capabilities allow are listed; the domain still enforces each.
 */
export function AuthorNav({
  company,
  briefing,
  capabilities,
  current,
  published = true,
  className,
}: {
  company: string;
  briefing: string;
  capabilities: readonly Capability[];
  current: AuthorView;
  published?: boolean;
  className?: string;
}) {
  const items = authorNavItems(company, briefing, capabilities, published).filter((i) => i.show);
  if (items.length <= 1) return null;
  return (
    <nav aria-label="Briefing views" className={cn("overflow-x-auto", className)}>
      <ul className="flex min-w-max gap-1 border-b border-line">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              aria-current={i.key === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-medium",
                i.key === current ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink",
                focusRing,
              )}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Standard frame for author views: eyebrow, serif title, briefing nav, content. */
export function AuthorPage({
  company,
  briefing,
  capabilities,
  current,
  title,
  eyebrow,
  description,
  published,
  actions,
  children,
  width = "wide",
  breadcrumb,
}: {
  company: string;
  briefing: string;
  capabilities: readonly Capability[];
  current: AuthorView;
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  published?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  width?: "wide" | "narrow";
  /** Server-rendered trail (members only); the top bar shows none on briefing routes. */
  breadcrumb?: Crumb[];
}) {
  return (
    <div className={cn("mx-auto w-full px-4 py-8 sm:px-6 lg:px-10", width === "wide" ? "max-w-7xl" : "max-w-4xl")}>
      {breadcrumb ? <PageBreadcrumb items={breadcrumb} /> : null}
      <AuthorNav company={company} briefing={briefing} capabilities={capabilities} current={current} published={published} className="mb-8" />
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-2 text-xs font-medium tracking-[0.14em] text-muted uppercase">{eyebrow}</p> : null}
          <h1 className="font-serif text-headline text-ink">{title}</h1>
          {description ? <div className="mt-2 max-w-2xl text-muted">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="mt-8">{children}</div>
    </div>
  );
}
