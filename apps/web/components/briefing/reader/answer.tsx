"use client";

import type { CitationDto } from "@cerebro/domain";
import { Badge, cn, focusRing } from "@cerebro/ui";

export interface AnswerPartView {
  text: string;
  kind: "stated" | "inferred";
  citations: string[];
}

/** In-page target for a citation. Evidence opens the evidence tab via the panel's hash handler. */
export function citationHref(c: CitationDto): string {
  if (c.kind === "evidence" && c.evidenceId) return `#evidence-${c.evidenceId}`;
  const id = c.blockId ?? "";
  if (id === "position") return "#briefing-headline";
  if (id === "open_questions") return "#open-questions";
  if (id.startsWith("psp_")) return "#briefing-perspective-title";
  return id ? `#${id}` : "#main";
}

const citationKey = (c: CitationDto) => (c.kind === "evidence" ? c.evidenceId : c.blockId) ?? "";

/**
 * A grounded answer: each part labelled "Stated in the briefing" or
 * "Inferred", with numbered citation links into the revision on screen.
 */
export function AnswerParts({ parts, citations }: { parts: AnswerPartView[]; citations: CitationDto[] }) {
  const numbered = new Map<string, number>();
  citations.forEach((c, i) => numbered.set(citationKey(c), i + 1));
  return (
    <div className="flex flex-col gap-3">
      {parts.map((p, i) => (
        <div key={i}>
          <Badge tone={p.kind === "stated" ? "success" : "info"} className="mb-1">
            {p.kind === "stated" ? "Stated in the briefing" : "Inferred"}
          </Badge>
          <p className="leading-relaxed text-ink">
            {p.text}
            {p.citations.map((id) => {
              const n = numbered.get(id);
              const c = n ? citations[n - 1] : undefined;
              if (!c || !n) return null;
              return (
                <a
                  key={id}
                  href={citationHref(c)}
                  aria-label={`Source ${n}: ${c.title}`}
                  className={cn("ml-0.5 align-super text-[0.7em] font-medium text-accent underline underline-offset-2", focusRing)}
                >
                  [{n}]
                </a>
              );
            })}
          </p>
        </div>
      ))}
      {citations.length ? (
        <div>
          <p className="text-xs font-medium tracking-[0.12em] text-muted uppercase">Sources in this version</p>
          <ol className="mt-2 flex flex-col gap-2">
            {citations.map((c, i) => (
              <li key={`${citationKey(c)}-${i}`} className="flex gap-2 text-sm">
                <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[0.7rem] font-medium text-on-accent">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <a href={citationHref(c)} className={cn("font-medium text-ink underline underline-offset-2 hover:text-accent", focusRing)}>
                    {c.title}
                  </a>
                  <span className="ml-1 text-muted">{c.kind === "evidence" ? "(evidence)" : "(briefing)"}</span>
                  {c.excerpt ? <span className="mt-0.5 line-clamp-3 block text-muted">“{c.excerpt}”</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
