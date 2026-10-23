"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SourceExtractionDto } from "@cerebro/domain";
import { Badge, Button } from "@cerebro/ui";
import { addChunkEvidenceAction, composeFromSourceAction } from "@/app/c/[company]/b/[briefing]/edit/actions";

const POLL_MS = 3000;
const MAX_POLLS = 60;

const STATUS: Record<SourceExtractionDto["status"], { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  pending: { label: "Waiting to extract", tone: "neutral" },
  running: { label: "Extracting", tone: "info" },
  succeeded: { label: "Extracted", tone: "success" },
  failed: { label: "Extraction failed", tone: "danger" },
};

/**
 * Private authoring sources attached to this draft: extraction status and
 * gaps, and chunk previews that can be added as *candidate* evidence. Chunks
 * are never reader evidence until approved and published.
 */
export function SourcesPanel({
  sources,
  target,
  version,
  dirty,
  onAdded,
}: {
  sources: SourceExtractionDto[];
  target: { company: string; briefing: string; briefingId: string };
  version: number;
  dirty: boolean;
  onAdded: (version: number) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  /** Source awaiting the author's confirmation to replace a draft that has content. */
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  const polls = useRef(0);

  // While any extraction is still running, refresh server data quietly so the
  // status (and an automatically composed draft) appears without a reload.
  const extracting = sources.some((s) => s.status === "pending" || s.status === "running");
  useEffect(() => {
    if (!extracting) {
      polls.current = 0;
      return;
    }
    const t = setInterval(() => {
      if (polls.current >= MAX_POLLS || document.visibilityState !== "visible") return;
      polls.current += 1;
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [extracting, router]);

  const compose = async (sourceId: string, replace: boolean) => {
    if (dirty || busy) return;
    setBusy(`compose:${sourceId}`);
    setMessage(null);
    let res: Awaited<ReturnType<typeof composeFromSourceAction>>;
    try {
      res = await composeFromSourceAction({ ...target, expectedVersion: version, sourceId, replace });
    } catch {
      res = { status: "error", message: "Couldn't reach the server. Nothing was changed; try again." };
    }
    setBusy(null);
    if (res.status === "composed") {
      setConfirmReplace(null);
      setMessage({
        tone: "ok",
        text: `Draft composed from the source with ${res.evidenceAdded} candidate evidence passage${res.evidenceAdded === 1 ? "" : "s"}. State the position, stakes and request, and approve the evidence you rely on before publishing.`,
      });
      onAdded(res.version);
      router.refresh();
    } else if (res.status === "needs_confirmation") {
      setConfirmReplace(sourceId);
    } else if (res.status === "conflict") {
      setConfirmReplace(null);
      setMessage({ tone: "error", text: `This draft was changed elsewhere (version ${res.currentVersion ?? "unknown"}). Reload before drafting from the source.` });
    } else {
      setConfirmReplace(null);
      setMessage({ tone: "error", text: res.message });
    }
  };

  if (!sources.length) return null;
  return (
    <section aria-labelledby="sources-title" className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sources-title" className="font-medium text-ink">
            Sources
          </h2>
          <p className="mt-0.5 text-sm text-muted">Private to collaborators. Readers see only excerpts you approve as evidence.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => router.refresh()}>
          Refresh status
        </Button>
      </div>
      <div aria-live="polite">
        {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "mt-3 text-sm font-medium text-danger" : "mt-3 text-sm text-success"}>{message.text}</p> : null}
      </div>
      <ul className="mt-4 flex flex-col gap-4">
        {sources.map((s) => (
          <li key={s.sourceId} className="rounded-md border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-ink">{s.title}</p>
              <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
              {s.completeness === "partial" ? <Badge tone="warning">Partial extraction</Badge> : null}
              {s.completeness === "complete" ? <Badge tone="success">Complete</Badge> : null}
            </div>
            {s.status === "pending" || s.status === "running" ? (
              <p className="mt-2 text-sm text-muted">
                Extraction runs in the background and this panel updates when it finishes. A blank draft is composed from the file automatically; a draft with your
                own content is never overwritten.
              </p>
            ) : null}
            {s.status === "succeeded" && s.chunkCount > 0 ? (
              <div className="mt-3">
                {confirmReplace === s.sourceId ? (
                  <div role="alertdialog" aria-labelledby={`replace-${s.sourceId}`} className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm">
                    <p id={`replace-${s.sourceId}`} className="text-warning">
                      This draft already has content. Replace its position, request and sections with a draft from this source? Existing evidence is kept.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" aria-disabled={busy !== null || undefined} onClick={() => compose(s.sourceId, true)}>
                        {busy === `compose:${s.sourceId}` ? "Replacing…" : "Replace the draft"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setConfirmReplace(null)}>
                        Keep my draft
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-disabled={dirty || busy !== null || undefined}
                    onClick={() => compose(s.sourceId, false)}
                  >
                    {busy === `compose:${s.sourceId}` ? "Drafting…" : "Draft from this source"}
                  </Button>
                )}
                {dirty ? <p className="mt-1 text-sm text-warning">Save your changes before drafting from the source.</p> : null}
              </div>
            ) : null}
            {s.status === "failed" ? (
              <p className="mt-2 text-sm text-danger">
                The file couldn't be extracted{s.errorCategory ? ` (${s.errorCategory.replace(/_/g, " ")})` : ""}. You can still write the draft and add evidence manually.
              </p>
            ) : null}
            {s.gaps.length ? (
              <div className="mt-3">
                <p className="text-sm font-medium text-ink">Extraction gaps</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-warning">
                  {s.gaps.map((g, i) => (
                    <li key={i}>
                      {g.message}
                      {g.locator ? ` (${g.locator})` : ""}
                      {g.affectsCompleteness ? " — some content may be missing" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {s.chunks.length ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-accent">Passages ({s.chunkCount})</summary>
                {dirty ? <p className="mt-2 text-sm text-warning">Save your changes before adding passages as evidence.</p> : null}
                <ol className="mt-2 flex flex-col gap-2">
                  {s.chunks.map((ch) => {
                    const title = `${s.title}${ch.locator ? `, ${ch.locator}` : ""}`.slice(0, 200);
                    return (
                      <li key={ch.id} className="rounded-md bg-subtle p-3 text-sm">
                        {ch.locator ? <p className="text-xs text-muted">{ch.locator}</p> : null}
                        <p className="mt-1 whitespace-pre-line text-fg">{ch.preview}</p>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-2"
                          aria-disabled={dirty || busy !== null || undefined}
                          aria-label={`Add passage ${ch.ordinal + 1} as candidate evidence`}
                          onClick={async () => {
                            if (dirty || busy) return;
                            setBusy(ch.id);
                            setMessage(null);
                            const res = await addChunkEvidenceAction({
                              ...target,
                              expectedVersion: version,
                              chunkId: ch.id,
                              title,
                              ...(s.attribution ? { attribution: s.attribution } : {}),
                            });
                            setBusy(null);
                            if (res.status === "saved") {
                              setMessage({ tone: "ok", text: "Added as candidate evidence. Approve it in the Evidence group before it can publish." });
                              onAdded(res.version);
                              router.refresh();
                            } else if (res.status === "conflict") {
                              setMessage({ tone: "error", text: `This draft was changed elsewhere (version ${res.currentVersion ?? "unknown"}). Reload before adding evidence.` });
                            } else {
                              setMessage({ tone: "error", text: res.message });
                            }
                          }}
                        >
                          {busy === ch.id ? "Adding…" : "Add as evidence"}
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
