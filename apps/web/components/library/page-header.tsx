import type { ReactNode } from "react";

/** Library page heading block: eyebrow, serif headline, description, actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  size = "display",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  size?: "display" | "headline";
}) {
  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-3 text-xs font-medium tracking-[0.14em] text-muted uppercase">{eyebrow}</p> : null}
        <h1 className={size === "display" ? "font-serif text-display text-ink" : "font-serif text-headline text-ink"}>{title}</h1>
        {description ? <div className="mt-3 max-w-2xl text-lg text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2 md:pt-1">{actions}</div> : null}
    </div>
  );
}

/** Section heading with an inline meta line, e.g. "Across the company · 12 published briefs · Visible to you". */
export function SectionHeading({ id, title, meta }: { id: string; title: ReactNode; meta?: ReactNode[] }) {
  return (
    <div className="mt-12 mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 id={id} className="font-serif text-headline text-ink">
        {title}
      </h2>
      {meta && meta.length ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
          {meta.map((m, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true">·</span> : null}
              {m}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** Standard content container for workspace pages. */
export function PageContainer({ children, width = "wide" }: { children: ReactNode; width?: "wide" | "narrow" }) {
  return <div className={width === "wide" ? "mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10" : "mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10"}>{children}</div>;
}
