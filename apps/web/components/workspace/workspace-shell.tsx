"use client";

import { usePathname, useSelectedLayoutSegment } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn, focusRing, Sheet } from "@cerebro/ui";
import { SkipLink } from "../chrome";
import { MenuIcon } from "../icons";
import { Breadcrumb } from "./breadcrumb";
import { ShellContext, type Crumb, type ShellApi } from "./shell-context";

export interface DepartmentCrumbMap {
  [departmentSlug: string]: { name: string; teams: Record<string, string> };
}

export interface WorkspaceShellProps {
  companySlug: string;
  companyName: string;
  /** Rail contents (server-rendered navigation). Rendered in the desktop rail and the mobile sheet. */
  rail: ReactNode;
  /** Right side of the top bar: search, user menu. */
  topBarEnd: ReactNode;
  /** Names for the default breadcrumb. */
  tree: DepartmentCrumbMap;
  /** Child segments under /c/[company] that collapse the rail by default. */
  collapsedSegments?: string[];
  /**
   * Child segments whose pages render their own server-side breadcrumb
   * (PageBreadcrumb) at the top of the content. The top bar shows no default
   * trail there, so nothing flashes while the page loads. Default: `b`.
   */
  pageCrumbSegments?: string[];
  children: ReactNode;
}

const SECTION_LABELS: Record<string, string> = {
  recent: "Recently updated",
  drafts: "My drafts",
  people: "People",
  settings: "Settings",
  admin: "Admin",
  new: "New brief",
  b: "Briefing",
};

function defaultCrumbs(pathname: string, companySlug: string, companyName: string, tree: DepartmentCrumbMap): Crumb[] {
  const base = `/c/${encodeURIComponent(companySlug)}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const seg = rest.split("/").filter(Boolean).map(decodeURIComponent);
  const company: Crumb = { label: companyName, href: base };
  if (seg.length === 0) return [company, { label: "All briefs" }];
  if (seg[0] === "d" && seg[1]) {
    const dept = tree[seg[1]];
    const deptCrumb: Crumb = { label: dept?.name ?? seg[1], href: `${base}/d/${encodeURIComponent(seg[1])}` };
    if (seg[2] === "t" && seg[3]) return [company, deptCrumb, { label: dept?.teams[seg[3]] ?? seg[3] }];
    return [company, { label: deptCrumb.label }];
  }
  const label = SECTION_LABELS[seg[0]!] ?? seg[0]!;
  if (seg.length > 1 && seg[0] === "people") return [company, { label, href: `${base}/people` }, { label: "Profile" }];
  return [company, { label }];
}

/**
 * Workspace chrome for every `/c/[company]/**` route: skip link, left rail
 * (desktop) / navigation sheet (mobile or collapsed), top bar, and `<main>`.
 *
 * The rail collapses automatically for child segments in `collapsedSegments`
 * (default: the reader, `b`). Pages can also render `<RailCollapsed />` and
 * `<SetBreadcrumb items={…} />` from ./shell-context. Pages under
 * `pageCrumbSegments` render a server-side `<PageBreadcrumb>` instead.
 */
export function WorkspaceShell({
  companySlug,
  companyName,
  rail,
  topBarEnd,
  tree,
  collapsedSegments = ["b"],
  pageCrumbSegments = ["b"],
  children,
}: WorkspaceShellProps) {
  const segment = useSelectedLayoutSegment();
  const pathname = usePathname();
  const [override, setCollapsedOverride] = useState<boolean | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[] | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const collapsed = override ?? (segment !== null && collapsedSegments.includes(segment));

  // Close the navigation sheet after a navigation.
  useEffect(() => setNavOpen(false), [pathname]);

  const api = useMemo<ShellApi>(() => ({ collapsed, setCollapsedOverride, setCrumbs }), [collapsed]);
  const pageOwnsCrumbs = segment !== null && pageCrumbSegments.includes(segment);
  const trail = crumbs ?? (pageOwnsCrumbs ? null : defaultCrumbs(pathname, companySlug, companyName, tree));

  return (
    <ShellContext.Provider value={api}>
      <SkipLink />
      <div className="flex min-h-dvh">
        <aside
          aria-label="Workspace"
          className={cn(
            "sticky top-0 hidden h-dvh w-68 shrink-0 overflow-y-auto border-r border-line bg-paper",
            !collapsed && "lg:block",
          )}
        >
          {rail}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/85">
            <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
              <Sheet
                open={navOpen}
                onOpenChange={setNavOpen}
                side="left"
                title="Workspace navigation"
                hideTitle
                className="md:w-80"
                trigger={
                  <button
                    type="button"
                    className={cn(
                      "-ml-2 inline-flex size-10 items-center justify-center rounded-md text-fg hover:bg-subtle",
                      !collapsed && "lg:hidden",
                      focusRing,
                    )}
                    aria-label="Open workspace navigation"
                  >
                    <MenuIcon size={20} />
                  </button>
                }
              >
                <div className="-mx-5">{rail}</div>
              </Sheet>
              {trail ? <Breadcrumb items={trail} className="min-w-0 flex-1" /> : <div className="min-w-0 flex-1" />}
              <div className="flex shrink-0 items-center gap-2">{topBarEnd}</div>
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
