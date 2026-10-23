"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, cn, Input, Select, Textarea } from "@cerebro/ui";
import { createBriefAction } from "@/app/c/[company]/new/actions";
import { IDLE, type ActionState } from "@/lib/action-state";

type Start = "blank" | "markdown" | "handoff" | "upload";

const STARTS: { value: Start; label: string; hint: string }[] = [
  { value: "blank", label: "Blank", hint: "A minimal structure with every required field marked as not yet stated." },
  { value: "markdown", label: "Paste Markdown", hint: "Headings become sections; we flag anything missing instead of inventing it." },
  { value: "upload", label: "Upload a file", hint: "PDF, Word (.docx), PowerPoint (.pptx), Markdown, text, or an image (PNG, JPEG, WebP). Kept private as a source." },
  { value: "handoff", label: "Paste a handoff (advanced)", hint: "A structured JSON handoff package from a connected LLM." },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" aria-disabled={pending || undefined}>
      {pending ? "Creating draft…" : "Create draft"}
    </Button>
  );
}

export interface NewBriefFormProps {
  company: string;
  companyName: string;
  homeOptions: { value: string; label: string }[];
  defaultHome: string;
  audienceOptions: { value: string; label: string }[];
}

/** New brief: home (inherited), explicit audience, and one start option. Creates a private draft. */
export function NewBriefForm({ company, homeOptions, defaultHome, audienceOptions }: NewBriefFormProps) {
  const [state, action] = useActionState<ActionState, FormData>(createBriefAction, IDLE);
  const [start, setStart] = useState<Start>("blank");
  const [audience, setAudience] = useState("company");
  const audienceLabel = audienceOptions.find((o) => o.value === audience)?.label ?? "";

  return (
    <form action={action} className="flex flex-col gap-8">
      <input type="hidden" name="company" value={company} />

      <fieldset className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <legend className="px-1 font-medium text-ink">Where it lives and who can read it</legend>
        <Select id="new-home" name="home" label="Home" hint="Where the briefing appears in the library." defaultValue={defaultHome} options={homeOptions} />
        <Select
          id="new-audience"
          name="audience"
          label="Audience"
          hint="Who can read it once you publish. Moving the home later doesn't change this."
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          options={audienceOptions}
        />
        <p className="rounded-md bg-subtle px-3 py-2 text-sm text-ink">
          When published, readable by: <strong className="font-medium">{audienceLabel}</strong>. Until then it is a private draft.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 font-medium text-ink">Start from</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {STARTS.map((s) => (
            <label
              key={s.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-4 focus-within:outline-2 focus-within:outline-focus",
                start === s.value ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-subtle",
              )}
            >
              <input type="radio" name="start" value={s.value} checked={start === s.value} onChange={() => setStart(s.value)} className="mt-1 size-4" />
              <span>
                <span className="block font-medium text-ink">{s.label}</span>
                <span className="mt-0.5 block text-sm text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-4">
        <Input
          id="new-title"
          name="title"
          label="Title"
          maxLength={200}
          hint={start === "blank" ? "You can change it later." : "Optional: overrides the title found in what you paste or upload."}
        />
        {start === "markdown" ? (
          <Textarea id="new-markdown" name="markdown" label="Markdown" required rows={14} hint="Use # for the title and ## for sections." className="font-mono text-sm" />
        ) : null}
        {start === "handoff" ? (
          <Textarea id="new-handoff" name="handoff" label="Handoff JSON" required rows={14} className="font-mono text-sm" />
        ) : null}
        {start === "upload" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-file" className="text-sm font-medium text-ink">
              File <span className="text-muted" aria-hidden="true">*</span>
              <span className="sr-only"> (required)</span>
            </label>
            <input
              id="new-file"
              name="file"
              type="file"
              required
              accept=".pdf,.docx,.pptx,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,image/png,image/jpeg,image/webp"
              aria-describedby="new-file-hint"
              className="rounded-md border border-line-strong bg-surface px-3 py-2 text-sm"
            />
            <p id="new-file-hint" className="text-sm text-muted">
              The file stays private to collaborators. Text extraction runs in the background; you'll see its status and any gaps in the editor.
              Images and scanned PDF pages are machine-read (OCR), so check that text against the original.
            </p>
          </div>
        ) : null}
      </div>

      <div aria-live="polite">
        {state.status === "error" ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
            {state.message}
          </p>
        ) : null}
      </div>

      <div>
        <Submit />
      </div>
    </form>
  );
}
