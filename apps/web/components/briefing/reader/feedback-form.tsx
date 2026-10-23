"use client";

import { Select, Textarea } from "@cerebro/ui";
import { ActionForm } from "@/components/forms/action-form";
import { submitFeedbackAction } from "@/app/c/[company]/b/[briefing]/actions";

export interface FeedbackTargetOption {
  value: string;
  label: string;
}

/**
 * Explicit, attributed feedback to the author. Separate from private Q&A:
 * nothing is sent until the reader submits this form.
 */
export function FeedbackForm({
  company,
  briefing,
  briefingId,
  revisionNumber,
  targets,
  defaultBlockId,
}: {
  company: string;
  briefing: string;
  briefingId: string;
  revisionNumber: number;
  targets: FeedbackTargetOption[];
  defaultBlockId?: string;
}) {
  return (
    <ActionForm action={submitFeedbackAction} submitLabel="Send to the author" pendingLabel="Sending…" resetOnSuccess>
      <input type="hidden" name="company" value={company} />
      <input type="hidden" name="briefing" value={briefing} />
      <input type="hidden" name="briefingId" value={briefingId} />
      <input type="hidden" name="revisionNumber" value={revisionNumber} />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Type</legend>
        <div className="flex flex-wrap gap-4">
          {[
            { v: "comment", l: "Comment" },
            { v: "concern", l: "Concern" },
            { v: "correction", l: "Correction" },
          ].map((o, i) => (
            <label key={o.v} className="inline-flex items-center gap-2 text-sm text-fg">
              <input type="radio" name="type" value={o.v} defaultChecked={i === 0} className="size-4 accent-[var(--cb-accent)]" />
              {o.l}
            </label>
          ))}
        </div>
      </fieldset>
      <Select
        id="feedback-block"
        name="blockId"
        label="About"
        defaultValue={defaultBlockId ?? ""}
        options={[{ value: "", label: "The whole briefing" }, ...targets]}
      />
      <Textarea id="feedback-text" name="text" label="Your feedback" required maxLength={5000} rows={4} />
      <p className="text-sm text-muted">
        Sent to the author with your name, attached to version {revisionNumber}. Your private questions are not included.
      </p>
    </ActionForm>
  );
}
