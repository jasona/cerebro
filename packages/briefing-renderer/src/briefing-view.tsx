import type { BriefingDocument, Perspective, Section } from "@cerebro/briefing-schema/client";
import { Badge, buttonClasses, cn, focusRing } from "@cerebro/ui";
import type { ReactNode } from "react";
import { BlockFrame } from "./blocks";
import { buildContext, type RenderContext, type RenderOptions } from "./context";
import { EvidenceList } from "./evidence";
import { formatDate } from "./format";
import { KIND_LABEL, REQUEST_LABEL } from "./labels";
import { OPEN_QUESTIONS_ID } from "./outline";
import { RichText } from "./rich-text";

export interface BriefingRevisionInfo {
  number: number;
  /** ISO date or timestamp. */
  publishedAt?: string;
  changeSummary?: string;
}

export interface BriefingAuthor {
  name: string;
  /** e.g. "Chief Executive Officer" */
  role?: string;
}

export interface BriefingViewProps extends RenderOptions {
  document: BriefingDocument;
  perspectiveId?: string;
  revision?: BriefingRevisionInfo;
  author?: BriefingAuthor;
  /** Organizational home, e.g. ["Acme", "Product", "Platform"]. */
  homePath?: string[];
  /** Perspective links (server-friendly). `null` means the overview. */
  perspectiveHref?: (perspectiveId: string | null) => string;
  /** Perspective buttons (client trees only). Used when perspectiveHref is absent. */
  onPerspectiveSelect?: (perspectiveId: string | null) => void;
  /** Render the in-page evidence list (the default target of evidence markers). Default true. */
  showEvidence?: boolean;
  /** Content placed after the header meta line, e.g. a "View changes" link. */
  headerSlot?: ReactNode;
  className?: string;
}


const eyebrow = "text-xs font-medium tracking-[0.14em] text-muted uppercase";

function Annotation({ ctx, id }: { ctx: RenderContext; id: string }) {
  const note = ctx.annotations?.[id];
  if (!note) return null;
  return (
    <div role="note" className="mb-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
      {note}
    </div>
  );
}

function Breadcrumb({ path }: { path: string[] }) {
  return (
    <nav aria-label="Briefing home" className="mb-3">
      <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
        {path.map((p, i) => (
          <li key={`${i}-${p}`} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden="true">/</span> : null}
            {p}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function PerspectiveSelector({
  perspectives,
  selected,
  href,
  onSelect,
}: {
  perspectives: Perspective[];
  selected?: Perspective;
  href?: BriefingViewProps["perspectiveHref"];
  onSelect?: BriefingViewProps["onPerspectiveSelect"];
}) {
  const options: Array<{ id: string | null; label: string }> = [{ id: null, label: "Overview" }, ...perspectives.map((p) => ({ id: p.id, label: p.label }))];
  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-9 items-center rounded-pill border px-4 text-sm transition-colors duration-(--cb-duration-fast)",
      active ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line-strong bg-surface text-fg hover:bg-subtle",
      focusRing,
    );
  const isActive = (id: string | null) => (selected ? selected.id === id : id === null);
  const list = (
    <ul className="flex flex-wrap gap-2">
      {options.map((o) => (
        <li key={o.id ?? "overview"}>
          {href ? (
            <a href={href(o.id)} aria-current={isActive(o.id) ? "true" : undefined} className={chip(isActive(o.id))}>
              {o.label}
            </a>
          ) : (
            <button type="button" aria-pressed={isActive(o.id)} className={chip(isActive(o.id))} onClick={() => onSelect?.(o.id)}>
              {o.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <span id="briefing-perspective-label" className="text-sm text-muted">
        Perspective
      </span>
      {href ? (
        <nav aria-labelledby="briefing-perspective-label">{list}</nav>
      ) : (
        <div role="group" aria-labelledby="briefing-perspective-label">
          {list}
        </div>
      )}
    </div>
  );
}

function PerspectivePanel({ perspective, document }: { perspective: Perspective; document: BriefingDocument }) {
  const sectionsById = new Map(document.sections.map((s) => [s.id, s]));
  const blockSection = new Map<string, Section>();
  for (const s of document.sections) for (const b of s.blocks) blockSection.set(b.id, s);
  const emphasised = perspective.emphasis.map((id) => sectionsById.get(id)).filter((s): s is Section => !!s);
  return (
    <section aria-labelledby="briefing-perspective-title" className="mt-8 rounded-lg border border-line bg-surface p-6">
      <p className={eyebrow}>Perspective</p>
      <h2 id="briefing-perspective-title" className="mt-1 font-serif text-title text-ink">
        {`Reading for ${perspective.label}`}
      </h2>
      {perspective.audience ? <p className="mt-0.5 text-sm text-muted">Written for {perspective.audience}</p> : null}
      {perspective.summary ? <RichText text={perspective.summary} className="mt-3 leading-relaxed text-fg" /> : null}
      {perspective.implications.length ? (
        <>
          <h3 className="mt-5 text-sm font-medium text-ink">{`What this means for ${perspective.label}`}</h3>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5 text-fg marker:text-accent">
            {perspective.implications.map((imp) => (
              <li key={imp.id} className="leading-relaxed">
                {imp.text}
                {imp.blockIds.length ? (
                  <span className="ml-1 text-sm">
                    {imp.blockIds.map((bid, i) => {
                      const s = blockSection.get(bid);
                      if (!s) return null;
                      return (
                        <a key={bid} href={`#${bid}`} className={cn("ml-1 text-accent underline underline-offset-2", focusRing)}>
                          See {s.title}
                          {imp.blockIds.length > 1 ? ` (${i + 1})` : ""}
                        </a>
                      );
                    })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {emphasised.length ? (
        <>
          <h3 className="mt-5 text-sm font-medium text-ink">Suggested focus</h3>
          <ol className="mt-2 flex flex-wrap gap-2">
            {emphasised.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className={cn("text-sm text-accent underline underline-offset-2", focusRing)}>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <p className="mt-4 text-xs text-muted">All sections remain visible. Emphasised sections are marked below.</p>
    </section>
  );
}

function DecisionPanel({ document, ctx }: { document: BriefingDocument; ctx: RenderContext }) {
  const { request } = document;
  const first = document.sections[0];
  return (
    <section id="request" aria-labelledby="briefing-request-label" className="mt-8 scroll-mt-24">
      <Annotation ctx={ctx} id="request" />
      <div className="flex flex-col gap-5 rounded-lg border border-accent/30 bg-accent-soft p-6 md:flex-row md:items-center md:p-7">
        <div className="min-w-0 flex-1">
          <h2 id="briefing-request-label" className="text-xs font-medium tracking-[0.14em] text-accent-ink uppercase">
            {REQUEST_LABEL[request.type]}
          </h2>
          <p className="mt-2 font-serif text-headline text-ink">{request.statement}</p>
          {request.detail ? <RichText text={request.detail} className="mt-2 text-accent-ink" /> : null}
          {request.dueDate ? (
            <p className="mt-3 text-sm font-medium text-accent-ink">
              Needed by <time dateTime={request.dueDate}>{formatDate(request.dueDate)}</time>
            </p>
          ) : null}
        </div>
        {first ? (
          <a
            href={`#${first.id}`}
            className={cn("shrink-0 text-sm font-medium text-accent-ink underline-offset-4 hover:underline md:border-l md:border-accent/30 md:pl-6", focusRing)}
          >
            Explore the rationale <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}

function SectionView({ section, ctx, emphasisFor }: { section: Section; ctx: RenderContext; emphasisFor?: string }) {
  const titleId = `${section.id}-title`;
  return (
    <section
      id={section.id}
      aria-labelledby={titleId}
      data-emphasised={emphasisFor ? "true" : undefined}
      className={cn("mt-12 scroll-mt-24 border-t border-line pt-10", emphasisFor && "-ml-4 border-l-4 border-l-accent pl-4 md:-ml-6 md:pl-5")}
    >
      {emphasisFor ? (
        <Badge tone="accent" className="mb-3">
          {`Emphasised for ${emphasisFor}`}
        </Badge>
      ) : null}
      <h2 id={titleId} className="font-serif text-headline text-ink">
        {section.title}
      </h2>
      <Annotation ctx={ctx} id={section.id} />
      <div className="mt-5 flex flex-col gap-6">
        {section.blocks.map((block) => (
          <BlockFrame key={block.id} block={block} ctx={ctx} />
        ))}
      </div>
    </section>
  );
}

/**
 * The canonical briefing renderer, shared by reader, preview and studio canvas.
 * Server-component compatible: no hooks, no editor controls. Interactivity is
 * injected via hrefs, callbacks and slots.
 */
export function BriefingView(props: BriefingViewProps) {
  const { document, perspectiveId, revision, author, homePath, perspectiveHref, onPerspectiveSelect, showEvidence = true, headerSlot, className } = props;
  const ctx = buildContext(document, props);
  const perspective = document.perspectives.find((p) => p.id === perspectiveId);
  const emphasised = new Set(perspective?.emphasis ?? []);
  const updated = revision?.publishedAt;
  const HeadlineTag = props.mode === "preview" ? "h2" : "h1";

  const meta = [
    author ? <span key="a">{author.name}{author.role ? <span className="text-muted">, {author.role}</span> : null}</span> : null,
    updated ? (
      <span key="u">
        {props.mode === "preview" ? "Last published " : "Updated "}
        <time dateTime={updated}>{formatDate(updated)}</time>
      </span>
    ) : null,
    revision ? <span key="v">Version {revision.number}</span> : null,
  ].filter(Boolean);

  return (
    <article aria-labelledby="briefing-headline" data-mode={props.mode} className={cn("mx-auto w-full max-w-measure-wide font-sans text-fg", className)}>
      {props.mode === "preview" ? (
        <div className="mb-6 rounded-md border border-info/30 bg-info-soft px-4 py-2 text-sm text-info">
          <strong className="font-semibold">Preview.</strong> This is how readers will see the briefing. It is not published.
        </div>
      ) : null}

      <header>
        {homePath?.length ? <Breadcrumb path={homePath} /> : null}
        <p className={eyebrow}>
          {KIND_LABEL[document.kind]}
          {updated ? (
            <>
              <span aria-hidden="true" className="mx-2">
                /
              </span>
              <span className="sr-only">, </span>
              {formatDate(updated, "month")}
            </>
          ) : null}
        </p>
        <Annotation ctx={ctx} id="position" />
        {/* In preview the host page owns the h1; the headline keeps its visual style. */}
        <HeadlineTag id="briefing-headline" className="mt-3 max-w-[22ch] font-serif text-display text-balance text-ink">
          {document.position.headline}
        </HeadlineTag>
        {meta.length || headerSlot ? (
          <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm text-fg">
            {meta.map((m, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 ? <span aria-hidden="true" className="text-muted">·</span> : null}
                {m}
              </span>
            ))}
            {headerSlot ? (
              <span className="flex items-center gap-2">
                {meta.length ? <span aria-hidden="true" className="text-muted">·</span> : null}
                {headerSlot}
              </span>
            ) : null}
          </p>
        ) : null}
        {revision?.changeSummary ? (
          <p className="mt-3 max-w-measure rounded-md bg-subtle px-3 py-2 text-sm text-fg">
            <span className="font-medium text-ink">What changed in version {revision.number}: </span>
            {revision.changeSummary}
          </p>
        ) : null}
        {document.perspectives.length && (perspectiveHref || onPerspectiveSelect) ? (
          <PerspectiveSelector perspectives={document.perspectives} selected={perspective} href={perspectiveHref} onSelect={onPerspectiveSelect} />
        ) : null}
        <RichText
          text={document.position.summary}
          className="mt-6 max-w-measure font-serif text-xl leading-normal text-ink md:text-2xl"
          paragraphClassName="mb-3 last:mb-0"
        />
      </header>

      {perspective ? <PerspectivePanel perspective={perspective} document={document} /> : null}

      <DecisionPanel document={document} ctx={ctx} />

      <section id="context" aria-labelledby="briefing-context-title" className="mt-12 max-w-measure scroll-mt-24">
        <h2 id="briefing-context-title" className={eyebrow}>
          Why it matters
        </h2>
        <Annotation ctx={ctx} id="context" />
        <RichText text={document.context.stakes} className="mt-3 text-lg leading-relaxed text-ink" />
        {document.context.background ? (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-ink">Background</h3>
            <RichText text={document.context.background} className="mt-2 leading-relaxed text-fg" />
          </div>
        ) : null}
      </section>

      {document.sections.map((section) => (
        <SectionView key={section.id} section={section} ctx={ctx} emphasisFor={emphasised.has(section.id) ? perspective?.label : undefined} />
      ))}

      {document.openQuestions.length ? (
        <section id={OPEN_QUESTIONS_ID} aria-labelledby="briefing-open-questions-title" className="mt-12 scroll-mt-24 border-t border-line pt-10">
          <h2 id="briefing-open-questions-title" className="font-serif text-headline text-ink">
            Open questions
          </h2>
          <p className="mt-2 text-sm text-muted">Questions the author has not yet resolved.</p>
          <ul className="mt-4 flex max-w-measure flex-col gap-3">
            {document.openQuestions.map((q) => (
              <li key={q.id} id={q.id} className="flex gap-3 leading-relaxed">
                <span aria-hidden="true" className="font-serif text-lg leading-6 text-accent">
                  ?
                </span>
                <span>{q.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showEvidence ? <EvidenceList document={document} mode={props.mode} className="mt-12 border-t border-line pt-10" /> : null}
    </article>
  );
}

/** Class string for an "Ask about this"-style block action, matching the concept. */
export const blockActionClasses = buttonClasses({ variant: "secondary", size: "sm", className: "rounded-pill" });
