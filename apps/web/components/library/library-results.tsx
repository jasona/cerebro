import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses, EmptyState } from "@cerebro/ui";
import { plural } from "@/lib/format";
import { withQuery } from "@/lib/paths";
import { DocumentIcon, PlusIcon } from "../icons";
import { BriefingList } from "./briefing-row";
import { SectionHeading } from "./page-header";
import type { BriefingRowData } from "./types";

/** "New brief" button inheriting the current home (department/team slugs). */
export function NewBriefButton({ href, label = "New brief" }: { href: string; label?: string }) {
  return (
    <Link href={href} className={buttonClasses({ size: "lg" })}>
      <PlusIcon size={18} />
      {label}
    </Link>
  );
}

export interface LibraryResultsProps {
  companySlug: string;
  headingId: string;
  heading: ReactNode;
  rows: BriefingRowData[];
  total: number;
  filtered: boolean;
  /** Link for the next page, if any. */
  nextHref?: string | null;
  emptyTitle: string;
  emptyDescription: ReactNode;
  emptyAction?: ReactNode;
  countNoun?: string;
}

/** Section heading with permission-filtered count, the rows, pagination, and an empty state. */
export function LibraryResults({
  companySlug,
  headingId,
  heading,
  rows,
  total,
  filtered,
  nextHref,
  emptyTitle,
  emptyDescription,
  emptyAction,
  countNoun = "published brief",
}: LibraryResultsProps) {
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        title={heading}
        meta={[filtered ? `${plural(total, "matching brief")}` : plural(total, countNoun), "Visible to you"]}
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={<DocumentIcon size={28} />}
          title={filtered ? "No briefs match these filters" : emptyTitle}
          description={filtered ? "Try a different search term, or clear the filters to see everything visible to you." : emptyDescription}
          action={filtered ? undefined : emptyAction}
          headingLevel={3}
        />
      ) : (
        <>
          <BriefingList companySlug={companySlug} briefings={rows} label={typeof heading === "string" ? heading : "Briefs"} />
          {nextHref ? (
            <div className="mt-6 flex justify-center">
              <Link href={nextHref} className={buttonClasses({ variant: "secondary" })}>
                More briefs
              </Link>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function nextPageHref(path: string, params: Record<string, string | undefined>, cursor: string | null): string | null {
  return cursor ? withQuery(path, { ...params, cursor }) : null;
}
