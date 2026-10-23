import type { DocumentDiff } from "@cerebro/briefing-schema";
import { Badge } from "@cerebro/ui";

const FIELD_LABEL: Record<string, string> = {
  headline: "headline",
  summary: "summary",
  stakes: "stakes",
  background: "background",
  type: "request type",
  statement: "request",
  detail: "request detail",
  dueDate: "due date",
};

/**
 * Structured comparison: the human summary lines, then changes grouped by
 * section (added / removed / changed / moved blocks), position and request
 * fields, perspectives, evidence and open questions.
 */
export function DiffView({ diff, sectionTitles }: { diff: DocumentDiff; sectionTitles: Map<string, string> }) {
  if (!diff.hasChanges) {
    return <p className="rounded-md border border-line bg-surface p-4 text-muted">No content changes between these versions.</p>;
  }
  const title = (id: string) => sectionTitles.get(id) ?? "Section";
  type Entry = { tone: "success" | "danger" | "info" | "neutral"; tag: string; text: string };
  const bySection = new Map<string, Entry[]>();
  const push = (sid: string, e: Entry) => bySection.set(sid, [...(bySection.get(sid) ?? []), e]);
  for (const b of diff.blocks.added) push(b.sectionId, { tone: "success", tag: "Added", text: `${b.type.replace("_", " ")}: ${b.label}` });
  for (const b of diff.blocks.removed) push(b.sectionId, { tone: "danger", tag: "Removed", text: `${b.type.replace("_", " ")}: ${b.label}` });
  for (const b of diff.blocks.changed) push(b.sectionId, { tone: "info", tag: "Changed", text: b.summary });
  for (const b of diff.blocks.moved) {
    push(b.toSectionId, {
      tone: "neutral",
      tag: "Moved",
      text: b.fromSectionId === b.toSectionId ? `${b.label} (reordered)` : `${b.label} (from “${title(b.fromSectionId)}”)`,
    });
  }
  const top: string[] = [
    ...diff.meta.map((m) => `${m.field === "title" ? "Title" : "Kind"}: “${m.from}” → “${m.to}”`),
    ...diff.position.map((f) => `Position ${FIELD_LABEL[f] ?? f} changed`),
    ...diff.context.map((f) => `Why it matters: ${FIELD_LABEL[f] ?? f} changed`),
    ...diff.request.map((f) => `Request: ${FIELD_LABEL[f] ?? f} changed`),
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="diff-summary">
        <h3 id="diff-summary" className="text-sm font-medium text-ink">
          Summary
        </h3>
        <ul className="mt-2 list-disc pl-5 text-fg">
          {diff.summary.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>

      {top.length ? (
        <section aria-labelledby="diff-top">
          <h3 id="diff-top" className="text-sm font-medium text-ink">
            Position, context and request
          </h3>
          <ul className="mt-2 list-disc pl-5 text-fg">
            {top.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.sections.added.length || diff.sections.removed.length || diff.sections.renamed.length || diff.sections.moved.length ? (
        <section aria-labelledby="diff-sections">
          <h3 id="diff-sections" className="text-sm font-medium text-ink">
            Sections
          </h3>
          <ul className="mt-2 flex flex-col gap-1 text-fg">
            {diff.sections.added.map((s) => (
              <li key={`a-${s.id}`}><Badge tone="success">Added</Badge> {s.title}</li>
            ))}
            {diff.sections.removed.map((s) => (
              <li key={`r-${s.id}`}><Badge tone="danger">Removed</Badge> {s.title}</li>
            ))}
            {diff.sections.renamed.map((s) => (
              <li key={`n-${s.id}`}><Badge tone="info">Renamed</Badge> “{s.from}” → “{s.to}”</li>
            ))}
            {diff.sections.moved.map((s) => (
              <li key={`m-${s.id}`}><Badge>Moved</Badge> {s.title} (position {s.fromIndex + 1} → {s.toIndex + 1})</li>
            ))}
          </ul>
        </section>
      ) : null}

      {bySection.size ? (
        <section aria-labelledby="diff-blocks">
          <h3 id="diff-blocks" className="text-sm font-medium text-ink">
            Changes by section
          </h3>
          <div className="mt-2 flex flex-col gap-4">
            {[...bySection].map(([sid, entries]) => (
              <div key={sid} className="rounded-md border border-line bg-surface p-4">
                <h4 className="font-serif text-lg text-ink">{title(sid)}</h4>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm text-fg">
                  {entries.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge tone={e.tone} className="shrink-0">
                        {e.tag}
                      </Badge>
                      <span>{e.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {[
        { key: "p", label: "Perspectives", added: diff.perspectives.added.map((p) => p.label), removed: diff.perspectives.removed.map((p) => p.label), changed: diff.perspectives.changed.map((p) => `${p.label}: ${p.fields.join(", ")}`) },
        { key: "e", label: "Evidence", added: diff.evidence.added.map((e) => e.title), removed: diff.evidence.removed.map((e) => e.title), changed: diff.evidence.changed.map((e) => `${e.title}: ${e.fields.join(", ")}`) },
        { key: "q", label: "Open questions", added: diff.openQuestions.added.map((q) => q.text), removed: diff.openQuestions.removed.map((q) => q.text), changed: diff.openQuestions.changed.map((q) => q.text) },
      ]
        .filter((g) => g.added.length || g.removed.length || g.changed.length)
        .map((g) => (
          <section key={g.key} aria-labelledby={`diff-${g.key}`}>
            <h3 id={`diff-${g.key}`} className="text-sm font-medium text-ink">
              {g.label}
            </h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-fg">
              {g.added.map((t, i) => (
                <li key={`a${i}`}><Badge tone="success">Added</Badge> {t}</li>
              ))}
              {g.removed.map((t, i) => (
                <li key={`r${i}`}><Badge tone="danger">Removed</Badge> {t}</li>
              ))}
              {g.changed.map((t, i) => (
                <li key={`c${i}`}><Badge tone="info">Changed</Badge> {t}</li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
