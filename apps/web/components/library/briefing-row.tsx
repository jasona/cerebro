import Link from "next/link";
import { Badge, cn, focusRing, StatusPill } from "@cerebro/ui";
import { isoString, relativeTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { BuildingIcon, DocumentIcon } from "../icons";
import { Avatar } from "../workspace/top-bar";
import type { BriefingRowData } from "./types";

/**
 * One briefing in a library list: title + summary (link), home path,
 * audience, author and update time. The whole title is the link target;
 * other cells are plain text so the row has a single tab stop.
 */
export function BriefingRow({ companySlug, briefing, now }: { companySlug: string; briefing: BriefingRowData; now?: Date }) {
  const href = briefing.href ?? paths.briefing(companySlug, briefing.slug);
  const verb = briefing.activityVerb ?? (briefing.version !== null && briefing.version > 1 ? "Updated" : "Published");
  return (
    <li className="group relative grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-b border-line py-4 last:border-b-0 md:grid-cols-[auto_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_8.5rem] md:items-center">
      <DocumentIcon size={22} className="row-span-2 mt-0.5 text-muted md:row-span-1 md:mt-0" />
      <div className="min-w-0">
        <h3 className="font-serif text-lg leading-snug text-ink">
          <Link href={href} className={cn("rounded-sm after:absolute after:inset-0 hover:text-accent", focusRing)}>
            {briefing.title}
            {/* Inside the link so the badge is announced with the title. */}
            {briefing.newVersion ? (
              <Badge tone="info" className="ml-2 align-middle font-sans">
                <span className="sr-only">, </span>New version
              </Badge>
            ) : briefing.unread ? (
              <Badge tone="accent" className="ml-2 align-middle font-sans">
                <span className="sr-only">, </span>Unread
              </Badge>
            ) : null}
          </Link>
        </h3>
        {briefing.summary ? <p className="mt-0.5 line-clamp-2 text-sm text-muted">{briefing.summary}</p> : null}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted md:contents">
        <p className="truncate md:col-auto">
          <span className="sr-only">Home: </span>
          {briefing.homePath.length ? briefing.homePath.join(" / ") : "Company"}
        </p>
        <p className="flex items-center gap-1.5 truncate">
          <BuildingIcon size={16} />
          <span className="sr-only">{briefing.status === "draft" ? "Your role: " : "Audience: "}</span>
          {briefing.audienceLabel}
        </p>
        {briefing.author ? (
          <p className="flex min-w-0 items-center gap-2 text-fg">
            <Avatar name={briefing.author.name} size="sm" />
            <span className="sr-only">Author: </span>
            <span className="truncate">{briefing.author.name}</span>
          </p>
        ) : (
          <span className="hidden md:block" />
        )}
        <p className="text-muted">
          {briefing.status === "draft" ? (
            <StatusPill status="draft" className="mr-2" />
          ) : briefing.status === "withdrawn" ? (
            <StatusPill status="withdrawn" className="mr-2" />
          ) : null}
          {verb} <time dateTime={isoString(briefing.updatedAt)}>{relativeTime(briefing.updatedAt, now)}</time>
          {briefing.version !== null ? <span className="sr-only">, version {briefing.version}</span> : null}
        </p>
      </div>
    </li>
  );
}

export function BriefingList({ companySlug, briefings, label }: { companySlug: string; briefings: BriefingRowData[]; label: string }) {
  const now = new Date();
  return (
    <ul aria-label={label} className="border-t border-line">
      {briefings.map((b) => (
        <BriefingRow key={b.slug} companySlug={companySlug} briefing={b} now={now} />
      ))}
    </ul>
  );
}
