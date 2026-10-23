"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RevisionOperation, SuggestionDto } from "@cerebro/domain";
import { Badge, Button, Textarea } from "@cerebro/ui";
import {
  acceptSuggestionAction,
  dismissSuggestionAction,
  requestProposalAction,
  suggestPerspectivesAction,
  type DecideOutcome,
} from "@/app/c/[company]/b/[briefing]/edit/actions";

type Message = { tone: "ok" | "error"; text: string };

const OP_LABELS: Record<RevisionOperation["op"], string> = {
  add_perspective: "Add perspective",
  update_perspective: "Change perspective",
  add_block: "Add block",
  replace_block: "Replace block",
  remove_block: "Remove block",
  set_text: "Change text",
};

function providerLabel(s: SuggestionDto): string {
  return s.provider === "deterministic" ? "Rule-based (local, no model)" : `${s.provider} · ${s.model}`;
}

function operationSummary(op: RevisionOperation, names: { blocks: Map<string, string>; sections: Map<string, string> }): string {
  switch (op.op) {
    case "add_perspective":
    case "update_perspective":
      return `${OP_LABELS[op.op]} “${op.perspective.label}”`;
    case "add_block":
      return `${OP_LABELS[op.op]} (${op.block.type.replace("_", " ")}) to “${names.sections.get(op.sectionId) ?? op.sectionId}”`;
    case "replace_block":
      return `${OP_LABELS[op.op]} “${names.blocks.get(op.block.id) ?? op.block.id}”`;
    case "remove_block":
      return `${OP_LABELS[op.op]} “${names.blocks.get(op.blockId) ?? op.blockId}”`;
    case "set_text":
      return `${OP_LABELS[op.op]}: ${op.path}`;
  }
}

/**
 * AI-assisted proposals for this draft (principle 2). Suggestions are stored
 * for review and change nothing on their own. Accepting one saves a new draft
 * version through the same expectedVersion check as "Save draft", so it is
 * disabled while the editor has unsaved changes; dismissing is final.
 */
export function SuggestionsPanel({
  suggestions,
  target,
  version,
  dirty,
  sections,
  blocks,
  onApplied,
}: {
  suggestions: SuggestionDto[];
  target: { company: string; briefing: string; briefingId: string };
  version: number;
  dirty: boolean;
  sections: { id: string; title: string }[];
  blocks: { value: string; label: string }[];
  onApplied: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [instruction, setInstruction] = useState("");
  const names = { sections: new Map(sections.map((s) => [s.id, s.title])), blocks: new Map(blocks.map((b) => [b.value, b.label])) };

  const run = async <T,>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    setBusy(key);
    setMessage(null);
    try {
      return await fn();
    } catch {
      return fallback;
    } finally {
      setBusy(null);
    }
  };

  const suggest = async () => {
    if (busy) return;
    const res = await run("suggest", () => suggestPerspectivesAction(target), { status: "error" as const, message: "Couldn't reach the server. Nothing was changed; try again." });
    if (res.status === "error") setMessage({ tone: "error", text: res.message });
    else if (res.status === "unavailable") setMessage({ tone: "error", text: res.notes ?? "Suggestions are unavailable right now. Your draft is unchanged." });
    else if (res.status === "none") setMessage({ tone: "ok", text: res.notes ?? "No new perspectives to suggest." });
    else setMessage({ tone: "ok", text: `${res.count} suggested perspective${res.count === 1 ? "" : "s"} to review below. Nothing changes until you accept one.${res.notes ? ` ${res.notes}` : ""}` });
    router.refresh();
  };

  const propose = async () => {
    if (busy) return;
    if (!instruction.trim()) {
      setMessage({ tone: "error", text: "Write an instruction first." });
      return;
    }
    const res = await run("propose", () => requestProposalAction({ ...target, instruction }), { status: "error" as const, message: "Couldn't reach the server. Nothing was changed; try again." });
    if (res.status === "error") setMessage({ tone: "error", text: res.message });
    else if (res.status === "suggested") {
      setInstruction("");
      setMessage({ tone: "ok", text: "A proposed revision is ready to review below. Nothing changes until you accept it." });
    } else if (res.status === "unavailable") setMessage({ tone: "error", text: res.explanation ?? "Proposals are unavailable right now." });
    else setMessage({ tone: res.status === "rejected" ? "error" : "ok", text: res.explanation ?? "No changes were proposed." });
    router.refresh();
  };

  const report = (res: DecideOutcome, label: string) => {
    if (res.status === "accepted") {
      setMessage({ tone: "ok", text: `Accepted “${label}”. Saved as draft version ${res.version}.` });
      onApplied();
    } else if (res.status === "dismissed") {
      setMessage({ tone: "ok", text: `Dismissed “${label}”.` });
    } else if (res.status === "conflict") {
      setMessage({
        tone: "error",
        text: res.stale
          ? "The draft changed after this proposal was made. Dismiss it and request a new one."
          : res.currentVersion
            ? `This draft was changed elsewhere (version ${res.currentVersion}). Reload before accepting.`
            : res.message,
      });
    } else {
      setMessage({ tone: "error", text: res.message });
    }
    router.refresh();
  };

  const accept = async (s: SuggestionDto, label: string) => {
    if (busy || dirty) return;
    const res = await run(`accept:${s.id}`, () => acceptSuggestionAction({ ...target, suggestionId: s.id, expectedVersion: version }), {
      status: "error" as const,
      message: "Couldn't reach the server. Nothing was changed; try again.",
    });
    report(res, label);
  };

  const dismiss = async (s: SuggestionDto, label: string) => {
    if (busy) return;
    const res = await run(`dismiss:${s.id}`, () => dismissSuggestionAction({ ...target, suggestionId: s.id }), {
      status: "error" as const,
      message: "Couldn't reach the server. Nothing was changed; try again.",
    });
    report(res, label);
  };

  return (
    <section aria-labelledby="suggestions-title" className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="suggestions-title" className="font-medium text-ink">
            Suggestions
          </h2>
          <p className="mt-0.5 max-w-prose text-sm text-muted">
            AI-assisted proposals for this draft. They change nothing until you accept one, and perspectives only change emphasis, never facts. Review
            every suggestion before you publish.
          </p>
        </div>
        <Button variant="secondary" size="sm" aria-disabled={busy !== null || undefined} onClick={suggest}>
          {busy === "suggest" ? "Suggesting…" : "Suggest perspectives"}
        </Button>
      </div>

      <div aria-live="polite">
        {message ? (
          <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "mt-3 text-sm font-medium text-danger" : "mt-3 text-sm text-success"}>
            {message.text}
          </p>
        ) : null}
      </div>
      {dirty && suggestions.length ? <p className="mt-3 text-sm text-warning">Save your changes before accepting a suggestion.</p> : null}

      {suggestions.length ? (
        <ul className="mt-4 flex flex-col gap-4">
          {suggestions.map((s) => {
            const label = s.perspective?.label ?? s.scope ?? "Proposed revision";
            const kindLabel = s.kind === "perspective" ? "Suggested perspective" : "Proposed revision";
            const headingId = `sugg-${s.id}-title`;
            return (
              <li key={s.id}>
                <article aria-labelledby={headingId} className="rounded-md border border-dashed border-line-strong bg-paper p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{kindLabel}</Badge>
                    <Badge>{providerLabel(s)}</Badge>
                  </div>
                  <h3 id={headingId} className="mt-2 font-medium text-ink">
                    {s.kind === "perspective" ? label : `Proposal: ${label}`}
                  </h3>
                  {s.perspective ? (
                    <div className="mt-2 flex flex-col gap-2 text-sm text-fg">
                      {s.perspective.audience ? <p className="text-muted">Written for: {s.perspective.audience}</p> : null}
                      {s.perspective.summary ? <p>{s.perspective.summary}</p> : null}
                      {s.perspective.emphasis.length ? (
                        <p>
                          <span className="text-muted">Emphasises: </span>
                          {s.perspective.emphasis.map((id) => names.sections.get(id) ?? id).join(", ")}
                        </p>
                      ) : null}
                      {s.perspective.implications.length ? (
                        <div>
                          <p className="text-muted">Implications</p>
                          <ul className="mt-1 list-disc pl-5">
                            {s.perspective.implications.map((i) => (
                              <li key={i.id}>
                                {i.text}
                                {i.blockIds.length ? <span className="text-muted"> — links to {i.blockIds.map((b) => names.blocks.get(b) ?? b).join(", ")}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {s.operations ? (
                    <div className="mt-2 text-sm text-fg">
                      {s.explanation ? <p>{s.explanation}</p> : null}
                      <ul className="mt-1 list-disc pl-5">
                        {s.operations.map((op, k) => (
                          <li key={k}>{operationSummary(op, names)}</li>
                        ))}
                      </ul>
                      {s.baseVersion !== version ? <p className="mt-1 text-warning">Made for draft version {s.baseVersion}; the draft has changed since.</p> : null}
                    </div>
                  ) : null}
                  {s.rationale ? <p className="mt-2 text-xs text-muted">Why suggested: {s.rationale}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      aria-label={`Accept ${kindLabel.toLowerCase()} “${label}”`}
                      aria-disabled={busy !== null || dirty || undefined}
                      title={dirty ? "Save your changes first" : undefined}
                      onClick={() => accept(s, label)}
                    >
                      {busy === `accept:${s.id}` ? "Accepting…" : "Accept"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Dismiss ${kindLabel.toLowerCase()} “${label}”`}
                      aria-disabled={busy !== null || undefined}
                      onClick={() => dismiss(s, label)}
                    >
                      {busy === `dismiss:${s.id}` ? "Dismissing…" : "Dismiss"}
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">No suggestions waiting for review.</p>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <Textarea
          id="suggest-instruction"
          label="Ask for a revision proposal"
          hint="For example: “Add a perspective for the sales team.” The proposal is shown here for review; nothing is applied automatically."
          rows={2}
          maxLength={5000}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <Button variant="secondary" size="sm" className="mt-2" aria-disabled={busy !== null || undefined} onClick={propose}>
          {busy === "propose" ? "Requesting…" : "Request proposal"}
        </Button>
      </div>
    </section>
  );
}
