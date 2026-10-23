import { buttonClasses, cn, focusRing } from "@cerebro/ui";
import Link from "next/link";
import { SearchIcon } from "../icons";

export interface FilterOption {
  value: string;
  label: string;
}
export interface FilterGroup {
  label: string;
  options: FilterOption[];
}

export interface LibraryFiltersProps {
  /** Form action (the current library path, without query). */
  action: string;
  values: { q?: string; department?: string; team?: string; author?: string; sort?: string };
  departments?: FilterOption[];
  /** Teams, grouped by department. */
  teams?: FilterGroup[];
  authors?: FilterOption[];
  sorts?: FilterOption[];
  /** Hidden fields to preserve (e.g. fixed scope). */
  hidden?: Record<string, string>;
}

const selectClass = cn(
  "h-11 w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 pr-8 text-sm text-fg",
  focusRing,
);

/**
 * Search + department/team/author/sort as a plain GET form (no client JS).
 * Each control has a visually hidden label; "Apply" submits, "Clear" resets.
 */
export function LibraryFilters({ action, values, departments, teams, authors, sorts, hidden }: LibraryFiltersProps) {
  const active = Boolean(values.q || values.department || values.team || values.author);
  return (
    <form role="search" aria-label="Filter briefs" action={action} method="get" className="mt-8 flex flex-col gap-3">
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <div className="relative">
          <label htmlFor="filter-q" className="sr-only">
            Search briefs or authors
          </label>
          <SearchIcon size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
          <input
            id="filter-q"
            name="q"
            type="search"
            defaultValue={values.q ?? ""}
            placeholder="Search briefs or authors…"
            className={cn("h-11 w-full rounded-md border border-line-strong bg-surface pr-3 pl-10 text-base text-fg placeholder:text-muted", focusRing)}
          />
        </div>
        {departments ? (
          <div>
            <label htmlFor="filter-department" className="sr-only">
              Department
            </label>
            <select id="filter-department" name="department" defaultValue={values.department ?? ""} className={selectClass}>
              <option value="">All departments</option>
              {departments.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {teams ? (
          <div>
            <label htmlFor="filter-team" className="sr-only">
              Team
            </label>
            <select id="filter-team" name="team" defaultValue={values.team ?? ""} className={selectClass}>
              <option value="">All teams</option>
              {teams.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : null}
        {authors ? (
          <div>
            <label htmlFor="filter-author" className="sr-only">
              Author
            </label>
            <select id="filter-author" name="author" defaultValue={values.author ?? ""} className={selectClass}>
              <option value="">All authors</option>
              {authors.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {sorts ? (
          <div className="mr-auto flex items-center gap-2 md:mr-0">
            <label htmlFor="filter-sort" className="text-sm text-muted">
              Sort
            </label>
            <select id="filter-sort" name="sort" defaultValue={values.sort ?? sorts[0]?.value} className={cn(selectClass, "h-9 w-auto")}>
              {sorts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {active ? (
          <Link href={action} className={buttonClasses({ variant: "ghost", size: "sm" })}>
            Clear filters
          </Link>
        ) : null}
        <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          Apply
        </button>
      </div>
    </form>
  );
}
