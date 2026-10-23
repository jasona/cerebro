"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";

export interface Crumb {
  label: string;
  href?: string;
}

export interface ShellApi {
  /** Rail hidden on desktop (opened from the menu button as a sheet). */
  collapsed: boolean;
  setCollapsedOverride: (value: boolean | null) => void;
  setCrumbs: (crumbs: Crumb[] | null) => void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useWorkspaceShell(): ShellApi | null {
  return useContext(ShellContext);
}

/**
 * Render inside any `/c/[company]/**` page to collapse the workspace rail
 * while it is mounted (the reader collapses by default; use this for other
 * focused views, e.g. an editor). `collapsed={false}` forces it open.
 */
export function RailCollapsed({ collapsed = true }: { collapsed?: boolean }) {
  const shell = useWorkspaceShell();
  const set = shell?.setCollapsedOverride;
  useEffect(() => {
    set?.(collapsed);
    return () => set?.(null);
  }, [set, collapsed]);
  return null;
}

/**
 * Replace the top-bar breadcrumb for the current page, e.g. the reader sets
 * Company / Department / Team / Briefing title. Company is not prepended
 * automatically; pass the full trail. The last crumb is the current page.
 */
export function SetBreadcrumb({ items }: { items: Crumb[] }) {
  const shell = useWorkspaceShell();
  const set = shell?.setCrumbs;
  const key = JSON.stringify(items);
  useEffect(() => {
    set?.(JSON.parse(key) as Crumb[]);
    return () => set?.(null);
  }, [set, key]);
  return null;
}

export type { ReactNode };
