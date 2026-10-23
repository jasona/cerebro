import { cn } from "@cerebro/ui";
import { Breadcrumb } from "./breadcrumb";
import type { Crumb } from "./shell-context";

/**
 * Server-rendered breadcrumb at the top of a page's content. Used on routes
 * where the top bar deliberately renders no breadcrumb (briefing routes, see
 * WorkspaceShell `pageCrumbSegments`), so the trail is correct on first paint
 * with no client-side flash.
 */
export function PageBreadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return <Breadcrumb items={items} className={cn("mb-6", className)} />;
}
