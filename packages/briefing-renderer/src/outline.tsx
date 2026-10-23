import type { BriefingDocument } from "@cerebro/briefing-schema/client";
import { cn, focusRing } from "@cerebro/ui";
import { formatReadingTime, estimateReadingMinutes } from "./reading-time";

export const OPEN_QUESTIONS_ID = "open-questions";

export interface BriefingOutlineProps {
  document: BriefingDocument;
  /** Section id to mark as current (e.g. from a scroll observer in the app). */
  activeId?: string;
  perspectiveId?: string;
  /** Prefix for hrefs, e.g. "/c/acme/b/growth" to link from outside the reader. Default: in-page anchors. */
  baseHref?: string;
  title?: string;
  showReadingTime?: boolean;
  className?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Numbered section list for the reader's left rail. */
export function BriefingOutline({
  document,
  activeId,
  perspectiveId,
  baseHref = "",
  title = "In this briefing",
  showReadingTime = true,
  className,
}: BriefingOutlineProps) {
  const perspective = document.perspectives.find((p) => p.id === perspectiveId);
  const emphasised = new Set(perspective?.emphasis ?? []);
  const items = [
    ...document.sections.map((s) => ({ id: s.id, title: s.title })),
    ...(document.openQuestions.length ? [{ id: OPEN_QUESTIONS_ID, title: "Open questions" }] : []),
  ];
  return (
    <nav aria-label={title} className={cn("text-sm", className)}>
      <p className="mb-4 text-xs font-medium tracking-[0.12em] text-muted uppercase" aria-hidden="true">
        {title}
      </p>
      <ol className="flex flex-col">
        {items.map((item, i) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`${baseHref}#${item.id}`}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "flex gap-3 border-l-2 py-2 pr-2 pl-3 hover:text-ink",
                  active ? "border-accent font-medium text-ink" : "border-transparent text-fg",
                  focusRing,
                )}
              >
                <span aria-hidden="true" className="text-muted tabular-nums">
                  {pad(i + 1)}
                </span>
                <span>
                  {item.title}
                  {emphasised.has(item.id) && perspective ? (
                    <span className="mt-0.5 block text-xs text-accent">{`Emphasised for ${perspective.label}`}</span>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      {showReadingTime ? (
        <p className="mt-4 border-t border-line pt-4 text-muted">{formatReadingTime(estimateReadingMinutes(document))}</p>
      ) : null}
    </nav>
  );
}
