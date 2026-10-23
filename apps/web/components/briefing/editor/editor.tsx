"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { BriefingView } from "@cerebro/briefing-renderer";
import {
  blockLabel,
  newId,
  parseDocument,
  type BlockType,
  type BriefingDocument,
  type DocumentIssue,
  type EvidenceItem,
  type Perspective,
  type Section,
} from "@cerebro/briefing-schema/client";
import type { SourceExtractionDto, SuggestionDto } from "@cerebro/domain";
import { Badge, Button, buttonClasses, cn, focusRing, Input, Select, Textarea } from "@cerebro/ui";
import { saveDraftAction, type SaveOutcome } from "@/app/c/[company]/b/[briefing]/edit/actions";
import { BLOCK_TYPE_LABELS, BLOCK_TYPE_ORDER, cleanDocument, newBlock } from "../document-utils";
import { briefingPaths } from "@/lib/paths";
import { BlockEditor } from "./block-editors";
import { AnnounceContext, focusSoon, Group, ItemControls, move } from "./controls";
import { RichTextField } from "./rich-text-field";
import { SourcesPanel } from "./sources-panel";
import { SuggestionsPanel } from "./suggestions-panel";

export interface BriefingEditorProps {
  company: string;
  briefing: string;
  briefingId: string;
  document: BriefingDocument;
  lockVersion: number;
  issues: DocumentIssue[];
  sources: SourceExtractionDto[];
  /** Pending AI-assisted proposals (perspectives, revisions). */
  suggestions?: SuggestionDto[];
  canPublish: boolean;
  /** Composer gaps reported when the draft was created (New brief). */
  gaps?: string[];
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "conflict"; currentVersion: number | null }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

const clone = <T,>(v: T): T => structuredClone(v);

function IssueList({ issues, label, tone }: { issues: DocumentIssue[]; label: string; tone: "danger" | "warning" }) {
  if (!issues.length) return null;
  return (
    <div className={cn("rounded-md border p-3", tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-warning/40 bg-warning-soft")}>
      <p className={cn("text-sm font-medium", tone === "danger" ? "text-danger" : "text-warning")}>
        {label} ({issues.length})
      </p>
      <ul className="mt-1 list-disc pl-5 text-sm text-fg">
        {issues.map((i, k) => (
          <li key={`${i.code}-${i.path}-${k}`}>
            {i.message}
            {i.blockId ? (
              <a href={`#edit-${i.blockId}`} className={cn("ml-1 text-accent underline underline-offset-2", focusRing)}>
                Go to block
              </a>
            ) : null}
            <span className="ml-1 font-mono text-xs text-muted">{i.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const EVIDENCE_STATUSES: { value: NonNullable<EvidenceItem["status"]>; label: string }[] = [
  { value: "candidate", label: "Candidate" },
  { value: "approved", label: "Approved" },
  { value: "excluded", label: "Excluded" },
];

/**
 * Structured editor; prose fields use `RichTextField` (Tiptap). Holds the whole draft document
 * in state and saves it with `expectedVersion`; the server validates. A
 * conflict never overwrites: the author's unsaved input stays on screen and
 * they choose to reload.
 */
export function BriefingEditor(props: BriefingEditorProps) {
  const { company, briefing, briefingId } = props;
  const router = useRouter();
  const [doc, setDoc] = useState<BriefingDocument>(() => clone(props.document));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(props.document));
  const [version, setVersion] = useState(props.lockVersion);
  const [issues, setIssues] = useState<DocumentIssue[]>(props.issues);
  const [invalidIssues, setInvalidIssues] = useState<DocumentIssue[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [showPreview, setShowPreview] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [, startTransition] = useTransition();
  const reloadRequested = useRef(false);

  const json = useMemo(() => JSON.stringify(doc), [doc]);
  const dirty = json !== savedJson;

  // Adopt a newer server version when there is nothing unsaved (or the author asked to reload).
  useEffect(() => {
    if (props.lockVersion === version && !reloadRequested.current) return;
    if (!reloadRequested.current && dirty) {
      if (props.lockVersion > version) setSave({ kind: "conflict", currentVersion: props.lockVersion });
      return;
    }
    reloadRequested.current = false;
    setDoc(clone(props.document));
    setSavedJson(JSON.stringify(props.document));
    setVersion(props.lockVersion);
    setIssues(props.issues);
    setInvalidIssues([]);
    setSave({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lockVersion, props.document]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const update = useCallback((fn: (d: BriefingDocument) => void) => {
    setDoc((d) => {
      const n = clone(d);
      fn(n);
      return n;
    });
  }, []);

  const onSave = () => {
    if (save.kind === "saving") return;
    setSave({ kind: "saving" });
    const cleaned = cleanDocument(doc);
    const submittedJson = json;
    startTransition(async () => {
      let res: SaveOutcome;
      try {
        res = await saveDraftAction({ company, briefing, briefingId, expectedVersion: version, document: cleaned });
      } catch {
        res = { status: "error", message: "Couldn't reach the server. Your changes are still here; try again." };
      }
      if (res.status === "saved") {
        setVersion(res.version);
        setSavedJson(submittedJson);
        setIssues(res.issues);
        setInvalidIssues([]);
        setSave({ kind: "saved", at: new Date() });
        setAnnouncement(`Saved. Draft version ${res.version}.`);
      } else if (res.status === "conflict") {
        setSave({ kind: "conflict", currentVersion: res.currentVersion });
      } else if (res.status === "invalid") {
        setInvalidIssues(res.issues);
        setSave({ kind: "invalid", message: res.message });
      } else {
        setSave({ kind: "error", message: res.message });
      }
    });
  };

  const reload = () => {
    reloadRequested.current = true;
    router.refresh();
  };

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        document.getElementById("editor-save")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const preview = useMemo(() => (showPreview ? parseDocument(cleanDocument(doc)) : null), [showPreview, doc]);

  const statusText =
    save.kind === "saving"
      ? "Saving…"
      : save.kind === "conflict"
        ? "Not saved: changed elsewhere"
        : save.kind === "invalid" || save.kind === "error"
          ? "Not saved"
          : dirty
            ? "Unsaved changes"
            : save.kind === "saved"
              ? `Saved · draft version ${version}`
              : `All changes saved · draft version ${version}`;

  const sectionOptions = doc.sections.map((s) => ({ id: s.id, title: s.title }));
  const blockOptions = doc.sections.flatMap((s) => s.blocks.map((b) => ({ value: b.id, label: `${s.title}: ${blockLabel(b) || BLOCK_TYPE_LABELS[b.type]}` })));

  return (
    <AnnounceContext.Provider value={setAnnouncement}>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Save bar */}
      <div className="sticky top-16 z-20 -mx-4 mb-6 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className={cn("text-sm", dirty || save.kind === "conflict" || save.kind === "invalid" || save.kind === "error" ? "font-medium text-warning" : "text-muted")}>
            {statusText}
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="secondary" aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? "Hide preview" : "Show preview"}
            </Button>
            {props.canPublish ? (
              dirty ? (
                <span className={buttonClasses({ variant: "secondary", className: "pointer-events-none opacity-50" })} aria-disabled="true" title="Save your changes first">
                  Preview &amp; publish
                </span>
              ) : (
                <Link href={briefingPaths.preview(company, briefing)} className={buttonClasses({ variant: "secondary" })}>
                  Preview &amp; publish
                </Link>
              )
            ) : null}
            <Button id="editor-save" onClick={onSave} aria-disabled={save.kind === "saving" || (!dirty && save.kind !== "invalid") || undefined}>
              {save.kind === "saving" ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
        {/* Hidden mirror of the version this edit is based on (sent as expectedVersion). */}
        <input type="hidden" name="expectedVersion" value={version} readOnly />
      </div>

      {save.kind === "conflict" ? (
        <div role="alert" className="mb-6 rounded-lg border border-danger/40 bg-danger-soft p-4">
          <p className="font-medium text-danger">
            This draft was changed elsewhere{save.currentVersion ? ` (version ${save.currentVersion})` : ""}.
          </p>
          <p className="mt-1 text-sm text-fg">
            Your changes have not been saved and are still shown below, based on version {version}. Copy anything you want to keep, then
            reload the latest version. Nothing was overwritten.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(cleanDocument(doc), null, 2));
                  setAnnouncement("Your unsaved document was copied to the clipboard as JSON.");
                } catch {
                  setAnnouncement("Copy failed.");
                }
              }}
            >
              Copy my changes (JSON)
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm("Discard your unsaved changes and load the latest version?")) reload();
              }}
            >
              Discard my changes and reload
            </Button>
          </div>
        </div>
      ) : null}

      {save.kind === "invalid" || save.kind === "error" ? (
        <div role="alert" className="mb-6 rounded-lg border border-danger/40 bg-danger-soft p-4">
          <p className="font-medium text-danger">{save.kind === "invalid" ? "The draft couldn't be saved because it has errors." : save.message}</p>
          {save.kind === "invalid" ? <p className="mt-1 text-sm text-fg">Fix the errors below and save again. Your changes are still here.</p> : null}
          {invalidIssues.length ? <div className="mt-3"><IssueList issues={invalidIssues} label="Errors" tone="danger" /></div> : null}
        </div>
      ) : null}

      {props.gaps?.length ? (
        <div className="mb-6 rounded-lg border border-info/30 bg-info-soft p-4">
          <p className="font-medium text-info">Gaps found while creating this draft</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-fg">
            {props.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={cn("grid gap-8", showPreview && "2xl:grid-cols-2")}>
        <div className="flex min-w-0 flex-col gap-6">
          {errors.length || warnings.length ? (
            <section aria-labelledby="issues-title" className="flex flex-col gap-3">
              <h2 id="issues-title" className="sr-only">
                Validation issues from the last save
              </h2>
              <IssueList issues={errors} label="Errors — must be fixed before publishing" tone="danger" />
              <IssueList issues={warnings} label="Warnings — you can publish with these" tone="warning" />
            </section>
          ) : null}

          <Group title="Basics">
            <Input id="doc-title" label="Title" required maxLength={200} value={doc.title} onChange={(e) => update((d) => void (d.title = e.target.value))} />
            <Select
              id="doc-kind"
              label="Kind"
              value={doc.kind}
              onChange={(e) => update((d) => void (d.kind = e.target.value as BriefingDocument["kind"]))}
              options={[
                { value: "strategy", label: "Strategy briefing" },
                { value: "decision", label: "Decision briefing" },
                { value: "plan", label: "Plan" },
                { value: "update", label: "Update" },
              ]}
            />
          </Group>

          <Group title="Position" description="What you think, in one line, then a short summary. Readers see this first.">
            <Input id="doc-headline" label="Headline" required maxLength={500} value={doc.position.headline} onChange={(e) => update((d) => void (d.position.headline = e.target.value))} />
            <RichTextField id="doc-summary" label="Summary" required rows={3} value={doc.position.summary} onChange={(v) => update((d) => void (d.position.summary = v))} />
          </Group>

          <Group title="Why it matters">
            <RichTextField id="doc-stakes" label="Stakes" required rows={3} value={doc.context.stakes} onChange={(v) => update((d) => void (d.context.stakes = v))} />
            <RichTextField id="doc-background" label="Background" rows={3} value={doc.context.background ?? ""} onChange={(v) => update((d) => void (d.context.background = v))} />
          </Group>

          <Group title="Request" description="What readers are asked to do.">
            <Select
              id="doc-request-type"
              label="Type"
              value={doc.request.type}
              onChange={(e) => update((d) => void (d.request.type = e.target.value as BriefingDocument["request"]["type"]))}
              options={[
                { value: "decision", label: "Decision" },
                { value: "approval", label: "Approval" },
                { value: "input", label: "Input" },
                { value: "awareness", label: "Awareness" },
              ]}
            />
            <Input id="doc-request-statement" label="Statement" required maxLength={500} value={doc.request.statement} onChange={(e) => update((d) => void (d.request.statement = e.target.value))} />
            <RichTextField id="doc-request-detail" label="Detail" rows={2} value={doc.request.detail ?? ""} onChange={(v) => update((d) => void (d.request.detail = v))} />
            <Input id="doc-request-due" label="Needed by" hint="YYYY-MM or YYYY-MM-DD" value={doc.request.dueDate ?? ""} onChange={(e) => update((d) => void (d.request.dueDate = e.target.value))} />
          </Group>

          <SectionsEditor doc={doc} update={update} />

          <PerspectivesEditor perspectives={doc.perspectives} sections={sectionOptions} blocks={blockOptions} update={update} />

          <SuggestionsPanel
            suggestions={props.suggestions ?? []}
            target={{ company, briefing, briefingId }}
            version={version}
            dirty={dirty}
            sections={sectionOptions}
            blocks={blockOptions}
            onApplied={() => {
              reloadRequested.current = true;
            }}
          />

          <EvidenceEditor evidence={doc.evidence} update={update} />

          <Group
            title="Open questions"
            description="Questions you have not resolved and want readers to know about."
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const id = newId("itm");
                  update((d) => void d.openQuestions.push({ id, text: "" }));
                  focusSoon(`oq-${id}`);
                }}
              >
                Add question
              </Button>
            }
          >
            {doc.openQuestions.length ? (
              <ol className="flex flex-col gap-3">
                {doc.openQuestions.map((q, i) => (
                  <li key={q.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Input
                      id={`oq-${q.id}`}
                      label={`Question ${i + 1}`}
                      required
                      fieldClassName="flex-1"
                      value={q.text}
                      onChange={(e) => update((d) => void (d.openQuestions[i]!.text = e.target.value))}
                    />
                    <ItemControls
                      idBase={`oq-${q.id}`}
                      noun="Question"
                      name={q.text}
                      index={i}
                      count={doc.openQuestions.length}
                      onMove={(to) => update((d) => void (d.openQuestions = move(d.openQuestions, i, to)))}
                      onRemove={() => update((d) => void d.openQuestions.splice(i, 1))}
                      removeLabel="Remove"
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">No open questions.</p>
            )}
          </Group>

          <SourcesPanel
            sources={props.sources}
            target={{ company, briefing, briefingId }}
            version={version}
            dirty={dirty}
            onAdded={() => {
              reloadRequested.current = true;
            }}
          />
        </div>

        {showPreview ? (
          <section aria-labelledby="live-preview-title" className="min-w-0 rounded-lg border border-line bg-paper p-4 sm:p-6">
            <h2 id="live-preview-title" className="mb-4 text-xs font-medium tracking-[0.14em] text-muted uppercase">
              Live preview (unsaved changes included)
            </h2>
            {preview?.ok ? (
              <BriefingView document={preview.document} mode="preview" showEvidence />
            ) : (
              <div className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
                <p className="font-medium">Preview unavailable until these are fixed:</p>
                <ul className="mt-1 list-disc pl-5">
                  {(preview && !preview.ok ? preview.issues : []).slice(0, 12).map((i, k) => (
                    <li key={k}>
                      {i.message} <span className="font-mono text-xs">{i.path}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </AnnounceContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Sections and blocks
// ---------------------------------------------------------------------------

function SectionsEditor({ doc, update }: { doc: BriefingDocument; update: (fn: (d: BriefingDocument) => void) => void }) {
  const [newType, setNewType] = useState<Record<string, BlockType>>({});
  return (
    <section aria-labelledby="sections-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sections-title" className="font-serif text-title text-ink">
          Sections
        </h2>
        <Button
          variant="secondary"
          onClick={() => {
            const id = newId("sec");
            update((d) => void d.sections.push({ id, title: "New section", blocks: [] }));
            focusSoon(`sec-${id}-title`);
          }}
        >
          Add section
        </Button>
      </div>
      {doc.sections.length === 0 ? <p className="text-sm text-muted">No sections yet. A briefing needs at least one section to publish.</p> : null}
      {doc.sections.map((s: Section, si) => (
        <fieldset key={s.id} className="rounded-lg border border-line bg-surface p-5">
          <legend className="sr-only">{`Section ${si + 1}: ${s.title}`}</legend>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Input
              id={`sec-${s.id}-title`}
              label={`Section ${si + 1} title`}
              required
              fieldClassName="flex-1"
              value={s.title}
              onChange={(e) => update((d) => void (d.sections[si]!.title = e.target.value))}
            />
            <ItemControls
              idBase={`sec-${s.id}`}
              noun="Section"
              name={s.title}
              index={si}
              count={doc.sections.length}
              onMove={(to) => update((d) => void (d.sections = move(d.sections, si, to)))}
              onRemove={() =>
                update((d) => {
                  d.sections.splice(si, 1);
                  for (const p of d.perspectives) p.emphasis = p.emphasis.filter((x) => x !== s.id);
                })
              }
            />
          </div>

          <ol className="mt-5 flex flex-col gap-4">
            {s.blocks.map((b, bi) => (
              <li key={b.id} id={`edit-${b.id}`} className="scroll-mt-32 rounded-md border border-line bg-paper p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <Badge>{BLOCK_TYPE_LABELS[b.type]}</Badge>
                  <ItemControls
                    idBase={`blk-${b.id}`}
                    noun="Block"
                    name={blockLabel(b)}
                    index={bi}
                    count={s.blocks.length}
                    onMove={(to) => update((d) => void (d.sections[si]!.blocks = move(d.sections[si]!.blocks, bi, to)))}
                    onRemove={() => update((d) => void d.sections[si]!.blocks.splice(bi, 1))}
                  />
                </div>
                <BlockEditor
                  block={b}
                  idBase={`blk-${b.id}`}
                  evidence={doc.evidence}
                  onChange={(nb) => update((d) => void (d.sections[si]!.blocks[bi] = nb))}
                />
              </li>
            ))}
          </ol>

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Select
              id={`sec-${s.id}-newtype`}
              label="New block type"
              value={newType[s.id] ?? "narrative"}
              onChange={(e) => setNewType((m) => ({ ...m, [s.id]: e.target.value as BlockType }))}
              options={BLOCK_TYPE_ORDER.map((t) => ({ value: t, label: BLOCK_TYPE_LABELS[t] }))}
            />
            <Button
              variant="secondary"
              onClick={() => {
                const block = newBlock(newType[s.id] ?? "narrative");
                update((d) => void d.sections[si]!.blocks.push(block));
                requestAnimationFrame(() => {
                  const el = document.getElementById(`edit-${block.id}`);
                  el?.scrollIntoView({ block: "center" });
                  el?.querySelector<HTMLElement>("input, textarea, select, [contenteditable='true']")?.focus();
                });
              }}
            >
              Add block
            </Button>
          </div>
        </fieldset>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Perspectives
// ---------------------------------------------------------------------------

function PerspectivesEditor({
  perspectives,
  sections,
  blocks,
  update,
}: {
  perspectives: Perspective[];
  sections: { id: string; title: string }[];
  blocks: { value: string; label: string }[];
  update: (fn: (d: BriefingDocument) => void) => void;
}) {
  return (
    <Group
      title="Perspectives"
      description="Audience-specific readings of the same argument. Perspectives never hide content."
      actions={
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={perspectives.length >= 8 || undefined}
          onClick={() => {
            if (perspectives.length >= 8) return;
            const id = newId("psp");
            update((d) => void d.perspectives.push({ id, label: "", summary: "", emphasis: [], implications: [] }));
            focusSoon(`psp-${id}-label`);
          }}
        >
          Add perspective
        </Button>
      }
    >
      {perspectives.length === 0 ? <p className="text-sm text-muted">No perspectives.</p> : null}
      {perspectives.map((p, pi) => (
        <div key={p.id} className="rounded-md border border-line bg-paper p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-muted">Perspective {pi + 1}</p>
            <ItemControls
              idBase={`psp-${p.id}`}
              noun="Perspective"
              name={p.label}
              index={pi}
              count={perspectives.length}
              onMove={(to) => update((d) => void (d.perspectives = move(d.perspectives, pi, to)))}
              onRemove={() => update((d) => void d.perspectives.splice(pi, 1))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input id={`psp-${p.id}-label`} label="Label" required maxLength={60} hint="e.g. Finance" value={p.label} onChange={(e) => update((d) => void (d.perspectives[pi]!.label = e.target.value))} />
            <Input id={`psp-${p.id}-audience`} label="Written for" hint="e.g. Finance leadership" value={p.audience ?? ""} onChange={(e) => update((d) => void (d.perspectives[pi]!.audience = e.target.value))} />
          </div>
          <RichTextField id={`psp-${p.id}-summary`} label="Summary" rows={3} fieldClassName="mt-4" value={p.summary} onChange={(v) => update((d) => void (d.perspectives[pi]!.summary = v))} />
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-ink">Emphasised sections</legend>
            {sections.length ? (
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                {sections.map((s) => (
                  <label key={s.id} className="inline-flex items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={p.emphasis.includes(s.id)}
                      onChange={(e) =>
                        update((d) => {
                          const q = d.perspectives[pi]!;
                          // Keep emphasis in reading order.
                          const set = new Set(q.emphasis);
                          if (e.target.checked) set.add(s.id);
                          else set.delete(s.id);
                          q.emphasis = d.sections.map((x) => x.id).filter((id) => set.has(id));
                        })
                      }
                    />
                    {s.title}
                  </label>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted">Add sections first.</p>
            )}
          </fieldset>
          <div className="mt-4">
            <p className="text-sm font-medium text-ink">Implications</p>
            <ol className="mt-2 flex flex-col gap-3">
              {p.implications.map((imp, ii) => (
                <li key={imp.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                  <Textarea
                    id={`psp-${p.id}-imp-${imp.id}`}
                    label={`Implication ${ii + 1}`}
                    required
                    rows={2}
                    value={imp.text}
                    onChange={(e) => update((d) => void (d.perspectives[pi]!.implications[ii]!.text = e.target.value))}
                  />
                  <div className="flex flex-wrap items-end gap-2">
                    <Select
                      id={`psp-${p.id}-imp-${imp.id}-block`}
                      label="Links to block"
                      value={imp.blockIds[0] ?? ""}
                      onChange={(e) => update((d) => void (d.perspectives[pi]!.implications[ii]!.blockIds = e.target.value ? [e.target.value] : []))}
                      options={[{ value: "", label: "None" }, ...blocks]}
                    />
                    <ItemControls
                      idBase={`psp-${p.id}-imp-${imp.id}`}
                      noun="Implication"
                      name={imp.text}
                      index={ii}
                      count={p.implications.length}
                      onMove={(to) => update((d) => void (d.perspectives[pi]!.implications = move(d.perspectives[pi]!.implications, ii, to)))}
                      onRemove={() => update((d) => void d.perspectives[pi]!.implications.splice(ii, 1))}
                      removeLabel="Remove"
                    />
                  </div>
                </li>
              ))}
            </ol>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                const id = newId("itm");
                update((d) => void d.perspectives[pi]!.implications.push({ id, text: "", blockIds: [] }));
                focusSoon(`psp-${p.id}-imp-${id}`);
              }}
            >
              Add implication
            </Button>
          </div>
        </div>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function EvidenceEditor({ evidence, update }: { evidence: EvidenceItem[]; update: (fn: (d: BriefingDocument) => void) => void }) {
  const [draft, setDraft] = useState({ title: "", excerpt: "", attribution: "" });
  const [error, setError] = useState("");
  const counts = { approved: 0, candidate: 0, excluded: 0 };
  for (const e of evidence) counts[e.status ?? "candidate"]++;
  return (
    <Group
      title="Evidence"
      description={
        <>
          Only <strong className="font-medium text-ink">approved</strong> excerpts publish. Candidates and excluded items stay private.{" "}
          {evidence.length ? `${counts.approved} approved, ${counts.candidate} candidate, ${counts.excluded} excluded.` : null}
        </>
      }
    >
      {evidence.length === 0 ? <p className="text-sm text-muted">No evidence yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {evidence.map((e, ei) => {
          const status = e.status ?? "candidate";
          return (
            <li key={e.id} className="rounded-md border border-line bg-paper p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={status === "approved" ? "success" : status === "excluded" ? "danger" : "warning"}>
                    {status === "approved" ? "Approved" : status === "excluded" ? "Excluded" : "Candidate"}
                  </Badge>
                  <span className="text-xs text-muted">
                    Origin: {e.origin === "llm_handoff" ? "connected LLM" : e.origin}
                    {e.sourceRef ? " · from a private source" : ""}
                  </span>
                </div>
                <fieldset>
                  <legend className="sr-only">{`Approval for “${e.title}”`}</legend>
                  <div className="flex overflow-hidden rounded-md border border-line-strong">
                    {EVIDENCE_STATUSES.map((s) => (
                      <label
                        key={s.value}
                        className={cn(
                          "cursor-pointer px-3 py-1.5 text-sm focus-within:outline-2 focus-within:outline-focus",
                          status === s.value ? "bg-accent text-on-accent" : "bg-surface text-fg hover:bg-subtle",
                        )}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          name={`ev-status-${e.id}`}
                          value={s.value}
                          checked={status === s.value}
                          onChange={() => update((d) => void (d.evidence[ei]!.status = s.value))}
                        />
                        {s.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <div className="mt-3 grid gap-3">
                <Input id={`ev-${e.id}-title`} label="Title" required value={e.title} onChange={(ev) => update((d) => void (d.evidence[ei]!.title = ev.target.value))} />
                <Textarea id={`ev-${e.id}-excerpt`} label="Excerpt" required rows={3} value={e.excerpt} onChange={(ev) => update((d) => void (d.evidence[ei]!.excerpt = ev.target.value))} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input id={`ev-${e.id}-attr`} label="Attribution" hint="Reader-visible, e.g. “Q3 cohort analysis, p. 8”" value={e.attribution ?? ""} onChange={(ev) => update((d) => void (d.evidence[ei]!.attribution = ev.target.value))} />
                  <Input id={`ev-${e.id}-locator`} label="Locator" value={e.locator ?? ""} onChange={(ev) => update((d) => void (d.evidence[ei]!.locator = ev.target.value))} />
                </div>
              </div>
              <div className="mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  aria-label={`Delete evidence “${e.title}”`}
                  onClick={() => {
                    if (!window.confirm(`Delete evidence “${e.title}”? References to it will be removed.`)) return;
                    update((d) => {
                      d.evidence.splice(ei, 1);
                      for (const s of d.sections) for (const b of s.blocks) b.evidenceRefs = b.evidenceRefs.filter((r) => r.evidenceId !== e.id);
                    });
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="rounded-md border border-dashed border-line-strong p-4">
        <p className="text-sm font-medium text-ink">Add evidence manually</p>
        <div className="mt-3 grid gap-3">
          <Input id="ev-new-title" label="Title" required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Textarea id="ev-new-excerpt" label="Excerpt" required rows={3} value={draft.excerpt} onChange={(e) => setDraft({ ...draft, excerpt: e.target.value })} />
          <Input id="ev-new-attr" label="Attribution" value={draft.attribution} onChange={(e) => setDraft({ ...draft, attribution: e.target.value })} />
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            if (!draft.title.trim() || !draft.excerpt.trim()) {
              setError("Add a title and an excerpt.");
              return;
            }
            setError("");
            const id = newId("ev");
            update((d) =>
              void d.evidence.push({
                id,
                title: draft.title.trim(),
                excerpt: draft.excerpt.trim(),
                ...(draft.attribution.trim() ? { attribution: draft.attribution.trim() } : {}),
                origin: "manual",
                status: "candidate",
              }),
            );
            setDraft({ title: "", excerpt: "", attribution: "" });
          }}
        >
          Add as candidate
        </Button>
      </div>
    </Group>
  );
}
