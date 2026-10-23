import type { BriefingDocument, EvidenceItem, EvidenceRef } from "@cerebro/briefing-schema/client";
import { Badge, cn, EmptyState, focusRing } from "@cerebro/ui";
import { evidenceAnchorId, visibleEvidence, type RenderContext, type RenderMode } from "./context";

const markerClass = cn(
  "inline-block rounded-sm px-0.5 align-super text-[0.7em] font-medium leading-none text-accent",
  "underline decoration-1 underline-offset-2 hover:bg-accent-soft",
  focusRing,
);

export interface EvidenceMarkersProps {
  refs: EvidenceRef[];
  blockId: string;
  ctx: RenderContext;
}

/** Inline [1] [2] markers for a block's evidence references. */
export function EvidenceMarkers({ refs, blockId, ctx }: EvidenceMarkersProps) {
  if (refs.length === 0) return null;
  const markers = refs.map((ref, i) => {
    const entry = ctx.evidence.get(ref.evidenceId);
    if (!entry) {
      // Reader: unpublished evidence is simply absent. Preview: make the gap visible.
      if (ctx.mode !== "preview") return null;
      return (
        <span key={`${ref.evidenceId}-${i}`} className="align-super text-[0.7em] font-medium text-danger" title="Evidence not included in this publication">
          [?]<span className="sr-only">Evidence reference not included in this publication</span>
        </span>
      );
    }
    const pending = entry.item.status === "candidate";
    const label = `Evidence ${entry.number}: ${entry.item.title}${pending ? " (not yet approved)" : ""}`;
    const content = <>[{entry.number}]</>;
    if (ctx.onEvidenceSelect) {
      const select = ctx.onEvidenceSelect;
      return (
        <button
          key={`${ref.evidenceId}-${i}`}
          type="button"
          aria-label={label}
          title={ref.note}
          className={cn(markerClass, pending && "text-warning")}
          onClick={() => select(ref.evidenceId, blockId)}
        >
          {content}
        </button>
      );
    }
    return (
      <a
        key={`${ref.evidenceId}-${i}`}
        href={ctx.evidenceHref ? ctx.evidenceHref(ref.evidenceId, blockId) : `#${evidenceAnchorId(ref.evidenceId)}`}
        aria-label={label}
        title={ref.note}
        className={cn(markerClass, pending && "text-warning")}
      >
        {content}
      </a>
    );
  });
  if (markers.every((m) => m === null)) return null;
  return <span className="whitespace-nowrap">{markers}</span>;
}

export interface EvidenceCardProps {
  item: EvidenceItem;
  number?: number;
  headingLevel?: 3 | 4;
  className?: string;
}

/** One approved excerpt with its reader-visible attribution. */
export function EvidenceCard({ item, number, headingLevel = 3, className }: EvidenceCardProps) {
  const Heading = `h${headingLevel}` as const;
  const meta = [item.attribution, item.locator].filter(Boolean);
  return (
    <article className={cn("rounded-lg border border-line bg-surface p-5", className)}>
      <p className="text-xs font-medium tracking-[0.12em] text-muted uppercase">
        {number !== undefined ? `Evidence ${number}` : "Supporting evidence"}
        {item.status === "candidate" ? (
          <Badge tone="warning" className="ml-2 tracking-normal normal-case">
            Not yet approved
          </Badge>
        ) : null}
      </p>
      <Heading className="mt-1 font-serif text-lg text-ink">{item.title}</Heading>
      {meta.length ? <p className="mt-0.5 text-sm text-muted">{meta.join(" · ")}</p> : null}
      <blockquote className="mt-3 border-l-2 border-line-strong pl-4 text-fg">
        {item.excerpt.split(/\n\s*\n/).map((p, i) => (
          <p key={i} className="mb-3 whitespace-pre-line last:mb-0">
            {p}
          </p>
        ))}
      </blockquote>
    </article>
  );
}

export interface EvidenceListProps {
  document: BriefingDocument;
  mode?: RenderMode;
  title?: string;
  /** Heading level of the list title; items use the next level. */
  headingLevel?: 2 | 3;
  className?: string;
}

/** The revision's evidence package: approved excerpts only in reader mode. */
export function EvidenceList({ document, mode = "reader", title = "Evidence", headingLevel = 2, className }: EvidenceListProps) {
  const items = visibleEvidence(document, mode);
  const Heading = `h${headingLevel}` as const;
  const headingId = "briefing-evidence-title";
  return (
    <section aria-labelledby={headingId} className={className}>
      <Heading id={headingId} className="font-serif text-headline text-ink">
        {title}
      </Heading>
      {items.length === 0 ? (
        <EmptyState
          className="mt-4"
          headingLevel={headingLevel === 2 ? 3 : 4}
          title="No supporting evidence attached"
          description="The author has not attached approved evidence to this briefing."
        />
      ) : (
        <ol className="mt-4 flex flex-col gap-4">
          {items.map((item, i) => (
            <li key={item.id} id={evidenceAnchorId(item.id)} className="scroll-mt-24">
              <EvidenceCard item={item} number={i + 1} headingLevel={headingLevel === 2 ? 3 : 4} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
