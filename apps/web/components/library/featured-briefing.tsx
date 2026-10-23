import Link from "next/link";
import { Badge, cn, focusRing } from "@cerebro/ui";
import { isoString, relativeTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { ArrowUpRightIcon } from "../icons";
import type { BriefingRowData } from "./types";

/** The featured briefing card at the top of a library view. */
export function FeaturedBriefing({ companySlug, briefing, tag }: { companySlug: string; briefing: BriefingRowData; tag?: string }) {
  const href = briefing.href ?? paths.briefing(companySlug, briefing.slug);
  return (
    <section aria-labelledby="featured-heading" className="mt-8">
      <h2 id="featured-heading" className="mb-3 text-xs font-medium tracking-[0.14em] text-muted uppercase">
        Featured briefing
      </h2>
      <article className="relative grid gap-4 rounded-xl border border-accent/15 bg-accent-soft px-6 py-6 md:grid-cols-[1fr_auto] md:items-end md:px-7">
        <div className="min-w-0">
          {tag ? <Badge className="mb-3 bg-surface/70 text-accent-ink">{tag}</Badge> : null}
          <h3 className="font-serif text-headline text-ink">
            <Link href={href} className={cn("rounded-sm after:absolute after:inset-0", focusRing)}>
              {briefing.title}
            </Link>
          </h3>
          {briefing.summary ? <p className="mt-2 max-w-3xl text-lg text-fg">{briefing.summary}</p> : null}
          <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {briefing.author ? (
              <>
                <span>{briefing.author.name}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>{briefing.audienceLabel === "Company" ? "Company-wide" : briefing.audienceLabel}</span>
            <span aria-hidden="true">·</span>
            <span>
              {briefing.version !== null && briefing.version > 1 ? "Updated" : "Published"}{" "}
              <time dateTime={isoString(briefing.updatedAt)}>{relativeTime(briefing.updatedAt)}</time>
            </span>
          </p>
        </div>
        <span aria-hidden="true" className="inline-flex items-center gap-1 font-medium text-accent-ink">
          Read briefing <ArrowUpRightIcon size={16} />
        </span>
      </article>
    </section>
  );
}
