import Link from "next/link";
import { cn, focusRing } from "@cerebro/ui";
import { ChevronDownIcon } from "../icons";

export interface SwitcherCompany {
  slug: string;
  name: string;
  role: string;
}

/**
 * Company switcher as a native disclosure (works without JavaScript).
 * Switching company changes the authorized resource set, so it is a full
 * navigation to the other company's library.
 */
export function CompanySwitcher({ current, companies }: { current: SwitcherCompany; companies: SwitcherCompany[] }) {
  const others = companies.filter((c) => c.slug !== current.slug);
  const tile = (
    <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-subtle font-medium text-ink">
      {current.name.slice(0, 1).toUpperCase()}
    </span>
  );
  const label = (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium text-ink">{current.name}</span>
      <span className="block text-[0.6875rem] tracking-wider text-muted uppercase">Company</span>
    </span>
  );
  if (others.length === 0) {
    return <div className="flex items-center gap-3 rounded-md px-2 py-2">{tile}{label}</div>;
  }
  return (
    <details className="group relative">
      <summary className={cn("flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-subtle", focusRing)}>
        {tile}
        {label}
        <ChevronDownIcon size={16} className="text-muted transition-transform group-open:rotate-180" />
        <span className="sr-only">Switch company</span>
      </summary>
      <div className="absolute inset-x-0 top-full z-40 mt-1 rounded-lg border border-line bg-surface p-1 shadow-raised">
        <p className="px-3 pt-2 pb-1 text-xs text-muted">Switch company</p>
        <ul>
          {others.map((c) => (
            <li key={c.slug}>
              <Link href={`/c/${encodeURIComponent(c.slug)}`} className={cn("block rounded-md px-3 py-2 text-sm hover:bg-subtle", focusRing)}>
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
