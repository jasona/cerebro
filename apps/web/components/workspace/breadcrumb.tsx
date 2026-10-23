import Link from "next/link";
import { cn, focusRing } from "@cerebro/ui";
import type { Crumb } from "./shell-context";

/** Accessible breadcrumb. The last item is marked aria-current="page". */
export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("overflow-hidden", className)}>
      <ol className="flex items-center gap-2 truncate text-sm text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${c.label}`} className={cn("flex min-w-0 items-center gap-2", !last && "hidden sm:flex")}>
              {c.href && !last ? (
                <Link href={c.href} className={cn("truncate rounded-sm hover:text-ink", focusRing)}>
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last && "text-ink")}>
                  {c.label}
                </span>
              )}
              {!last ? (
                <span aria-hidden="true" className="text-line-strong">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
