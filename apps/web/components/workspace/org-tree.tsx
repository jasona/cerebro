"use client";

import { useState } from "react";
import { cn, focusRing } from "@cerebro/ui";
import { ChevronIcon, FolderIcon, PeopleIcon } from "../icons";
import { NavLink } from "./nav-link";

export interface TreeTeam {
  id: string;
  slug: string;
  name: string;
}
export interface TreeDepartment {
  id: string;
  slug: string;
  name: string;
  teams: TreeTeam[];
}

/**
 * Departments & Teams navigation. Each department is a link plus a separate
 * disclosure button (aria-expanded / aria-controls), so both navigating and
 * expanding are keyboard operable without nesting interactive elements.
 */
export function OrgTree({ companySlug, departments }: { companySlug: string; departments: TreeDepartment[] }) {
  const base = `/c/${encodeURIComponent(companySlug)}/d/`;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (departments.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted">No departments yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {departments.map((d) => {
        const href = `${base}${encodeURIComponent(d.slug)}`;
        // Expanded by default (as in the workspace concept).
        const open = expanded[d.id] ?? true;
        const listId = `tree-${d.id}`;
        return (
          <li key={d.id}>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-expanded={d.teams.length > 0 ? open : undefined}
                aria-controls={d.teams.length > 0 ? listId : undefined}
                disabled={d.teams.length === 0}
                onClick={() => setExpanded((s) => ({ ...s, [d.id]: !open }))}
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink disabled:invisible",
                  focusRing,
                )}
              >
                <ChevronIcon size={14} className={cn("transition-transform", (open) && d.teams.length > 0 && "rotate-90")} />
                <span className="sr-only">
                  {open ? "Collapse" : "Expand"} {d.name}
                </span>
              </button>
              <NavLink href={href} icon={<FolderIcon size={17} />} className="flex-1 px-2">
                {d.name}
              </NavLink>
            </div>
            {d.teams.length > 0 && (open) ? (
              <ul id={listId} className="ml-[1.375rem] flex flex-col gap-0.5 border-l border-line py-0.5 pl-2">
                {d.teams.map((t) => (
                  <li key={t.id}>
                    <NavLink href={`${href}/t/${encodeURIComponent(t.slug)}`} icon={<PeopleIcon size={16} />} className="px-2 text-sm">
                      {t.name}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
