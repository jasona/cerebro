"use client";

import { useState } from "react";
import { newId, type Block, type EvidenceItem } from "@cerebro/briefing-schema/client";
import { Button, Input, Select, Textarea } from "@cerebro/ui";
import { ItemControls, move } from "./controls";

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;
type Edit<B> = { block: B; onChange: (b: B) => void; idBase: string };

const LEVELS = [
  { value: "", label: "Not set" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
const numValue = (n: number) => (Number.isFinite(n) ? String(n) : "");

function NarrativeEditor({ block, onChange, idBase }: Edit<Of<"narrative">>) {
  return (
    <>
      <Select
        id={`${idBase}-role`}
        label="Role"
        value={block.role}
        onChange={(e) => onChange({ ...block, role: e.target.value as Of<"narrative">["role"] })}
        options={[
          { value: "general", label: "General" },
          { value: "context", label: "Context" },
          { value: "rationale", label: "Rationale" },
          { value: "alternative", label: "Alternative" },
        ]}
      />
      <Textarea
        id={`${idBase}-text`}
        label="Text"
        required
        rows={5}
        value={block.text}
        hint="Separate paragraphs with a blank line. **bold**, _italic_ and [links](https://…) are supported."
        onChange={(e) => onChange({ ...block, text: e.target.value })}
      />
    </>
  );
}

function KeyFindingEditor({ block, onChange, idBase }: Edit<Of<"key_finding">>) {
  return (
    <>
      <Input id={`${idBase}-statement`} label="Finding" required value={block.statement} onChange={(e) => onChange({ ...block, statement: e.target.value })} />
      <Textarea id={`${idBase}-detail`} label="Detail" rows={3} value={block.detail ?? ""} onChange={(e) => onChange({ ...block, detail: e.target.value })} />
    </>
  );
}

function MetricEditor({ block, onChange, idBase }: Edit<Of<"metric">>) {
  return (
    <>
      <Input id={`${idBase}-label`} label="Label" required value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Input id={`${idBase}-value`} label="Value" required type="number" inputMode="decimal" step="any" value={numValue(block.value)} onChange={(e) => onChange({ ...block, value: num(e.target.value) })} />
        <Input id={`${idBase}-unit`} label="Unit" hint="e.g. %, $M, days" value={block.unit} onChange={(e) => onChange({ ...block, unit: e.target.value })} />
        <Input id={`${idBase}-asof`} label="As of" hint="YYYY-MM or YYYY-MM-DD" value={block.asOf ?? ""} onChange={(e) => onChange({ ...block, asOf: e.target.value })} />
      </div>
      <Textarea id={`${idBase}-context`} label="Context" rows={2} value={block.context ?? ""} onChange={(e) => onChange({ ...block, context: e.target.value })} />
      <label className="inline-flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4"
          checked={!!block.comparison}
          onChange={(e) => {
            const { comparison: _omit, ...rest } = block;
            onChange(e.target.checked ? { ...block, comparison: { label: "", value: 0 } } : rest);
          }}
        />
        Compare with another value
      </label>
      {block.comparison ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input id={`${idBase}-cmp-label`} label="Comparison label" required value={block.comparison.label} onChange={(e) => onChange({ ...block, comparison: { ...block.comparison!, label: e.target.value } })} />
          <Input id={`${idBase}-cmp-value`} label="Comparison value" required type="number" step="any" value={numValue(block.comparison.value)} onChange={(e) => onChange({ ...block, comparison: { ...block.comparison!, value: num(e.target.value) } })} />
        </div>
      ) : null}
    </>
  );
}

function ComparisonEditor({ block, onChange, idBase }: Edit<Of<"comparison">>) {
  const setColumns = (columns: string[], rows = block.rows) => onChange({ ...block, columns, rows });
  return (
    <>
      <Input id={`${idBase}-title`} label="Title" value={block.title ?? ""} onChange={(e) => onChange({ ...block, title: e.target.value })} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <caption className="sr-only">Comparison grid: column headings, then one row per item</caption>
          <thead>
            <tr>
              <th scope="col" className="p-1 text-left font-medium text-muted">
                Row label
              </th>
              {block.columns.map((col, ci) => (
                <th key={ci} scope="col" className="p-1 text-left align-bottom">
                  <label htmlFor={`${idBase}-col-${ci}`} className="sr-only">{`Column ${ci + 1} heading`}</label>
                  <div className="flex gap-1">
                    <input
                      id={`${idBase}-col-${ci}`}
                      value={col}
                      onChange={(e) => setColumns(block.columns.map((c, i) => (i === ci ? e.target.value : c)))}
                      className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 font-medium"
                    />
                    {block.columns.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove column ${ci + 1}`}
                        onClick={() => setColumns(block.columns.filter((_, i) => i !== ci), block.rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== ci) })))}
                      >
                        ×
                      </Button>
                    ) : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                <th scope="row" className="p-1">
                  <label htmlFor={`${idBase}-row-${ri}`} className="sr-only">{`Row ${ri + 1} label`}</label>
                  <input
                    id={`${idBase}-row-${ri}`}
                    value={row.label}
                    onChange={(e) => onChange({ ...block, rows: block.rows.map((r, i) => (i === ri ? { ...r, label: e.target.value } : r)) })}
                    className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 font-medium"
                  />
                </th>
                {block.columns.map((col, ci) => (
                  <td key={ci} className="p-1">
                    <label htmlFor={`${idBase}-cell-${ri}-${ci}`} className="sr-only">{`Row ${ri + 1}, ${col || `column ${ci + 1}`}`}</label>
                    <input
                      id={`${idBase}-cell-${ri}-${ci}`}
                      value={row.cells[ci] ?? ""}
                      onChange={(e) =>
                        onChange({
                          ...block,
                          rows: block.rows.map((r, i) => {
                            if (i !== ri) return r;
                            const cells = block.columns.map((_, k) => r.cells[k] ?? "");
                            cells[ci] = e.target.value;
                            return { ...r, cells };
                          }),
                        })
                      }
                      className="w-full rounded-md border border-line-strong bg-surface px-2 py-1"
                    />
                  </td>
                ))}
                <td className="p-1">
                  {block.rows.length > 1 ? (
                    <Button variant="ghost" size="sm" aria-label={`Remove row ${ri + 1}`} onClick={() => onChange({ ...block, rows: block.rows.filter((_, i) => i !== ri) })}>
                      ×
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => onChange({ ...block, rows: [...block.rows, { label: "", cells: block.columns.map(() => "") }] })}>
          Add row
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={block.columns.length >= 8 || undefined}
          onClick={() => block.columns.length < 8 && setColumns([...block.columns, `Column ${block.columns.length + 1}`], block.rows.map((r) => ({ ...r, cells: [...r.cells, ""] })))}
        >
          Add column
        </Button>
      </div>
    </>
  );
}

function ChartEditor({ block, onChange, idBase }: Edit<Of<"chart">>) {
  const categories = block.series[0]?.points.map((p) => p.x) ?? [];
  const valueAt = (si: number, ci: number) => block.series[si]?.points[ci]?.y ?? Number.NaN;
  const rebuild = (cats: string[], values: (si: number, ci: number) => number, labels = block.series.map((s) => s.label)) =>
    onChange({ ...block, series: labels.map((label, si) => ({ label, points: cats.map((x, ci) => ({ x, y: values(si, ci) })) })) });
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Input id={`${idBase}-title`} label="Title" required fieldClassName="sm:col-span-2" value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} />
        <Select
          id={`${idBase}-kind`}
          label="Chart type"
          value={block.kind}
          onChange={(e) => onChange({ ...block, kind: e.target.value as "bar" | "line" })}
          options={[
            { value: "bar", label: "Bar" },
            { value: "line", label: "Line" },
          ]}
        />
      </div>
      <Input id={`${idBase}-unit`} label="Unit" hint="Shown with every value, e.g. %" value={block.unit ?? ""} onChange={(e) => onChange({ ...block, unit: e.target.value })} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-sm">
          <caption className="text-left text-sm font-medium text-ink">Data: one row per category, one column per series</caption>
          <thead>
            <tr>
              <th scope="col" className="p-1 text-left font-medium text-muted">
                Category
              </th>
              {block.series.map((s, si) => (
                <th key={si} scope="col" className="p-1 text-left">
                  <label htmlFor={`${idBase}-series-${si}`} className="sr-only">{`Series ${si + 1} name`}</label>
                  <div className="flex gap-1">
                    <input
                      id={`${idBase}-series-${si}`}
                      value={s.label}
                      onChange={(e) => rebuild(categories, valueAt, block.series.map((x, i) => (i === si ? e.target.value : x.label)))}
                      className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 font-medium"
                    />
                    {block.series.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove series ${si + 1}`}
                        onClick={() => onChange({ ...block, series: block.series.filter((_, i) => i !== si) })}
                      >
                        ×
                      </Button>
                    ) : null}
                  </div>
                </th>
              ))}
              <th className="p-1">
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, ci) => (
              <tr key={ci}>
                <th scope="row" className="p-1">
                  <label htmlFor={`${idBase}-cat-${ci}`} className="sr-only">{`Category ${ci + 1}`}</label>
                  <input
                    id={`${idBase}-cat-${ci}`}
                    value={cat}
                    onChange={(e) => rebuild(categories.map((c, i) => (i === ci ? e.target.value : c)), valueAt)}
                    className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 font-medium"
                  />
                </th>
                {block.series.map((s, si) => (
                  <td key={si} className="p-1">
                    <label htmlFor={`${idBase}-v-${ci}-${si}`} className="sr-only">{`${s.label || `Series ${si + 1}`}, ${cat || `category ${ci + 1}`}`}</label>
                    <input
                      id={`${idBase}-v-${ci}-${si}`}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={numValue(valueAt(si, ci))}
                      onChange={(e) => rebuild(categories, (a, b) => (a === si && b === ci ? num(e.target.value) : valueAt(a, b)))}
                      className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 tabular-nums"
                    />
                  </td>
                ))}
                <td className="p-1">
                  {categories.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove category ${cat || ci + 1}`}
                      onClick={() => {
                        const keep = categories.map((_, i) => i).filter((i) => i !== ci);
                        rebuild(keep.map((i) => categories[i]!), (si, k) => valueAt(si, keep[k]!));
                      }}
                    >
                      ×
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => rebuild([...categories, `Category ${categories.length + 1}`], (si, ci) => (ci < categories.length ? valueAt(si, ci) : 0))}>
          Add category
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={block.series.length >= 8 || undefined}
          onClick={() =>
            block.series.length < 8 &&
            onChange({ ...block, series: [...block.series, { label: `Series ${block.series.length + 1}`, points: categories.map((x) => ({ x, y: 0 })) }] })
          }
        >
          Add series
        </Button>
      </div>
      <Textarea
        id={`${idBase}-alt`}
        label="Text alternative"
        required
        rows={2}
        hint="Describe what the chart shows for readers who can't see it. A data table is also generated."
        value={block.altText}
        onChange={(e) => onChange({ ...block, altText: e.target.value })}
      />
      <Input id={`${idBase}-caption`} label="Caption" hint="e.g. data source and period" value={block.caption ?? ""} onChange={(e) => onChange({ ...block, caption: e.target.value })} />
    </>
  );
}

function TimelineEditor({ block, onChange, idBase }: Edit<Of<"timeline">>) {
  const items = block.items;
  return (
    <>
      <Input id={`${idBase}-title`} label="Title" value={block.title ?? ""} onChange={(e) => onChange({ ...block, title: e.target.value })} />
      <ol className="flex flex-col gap-3">
        {items.map((it, i) => (
          <li key={it.id} className="rounded-md border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-muted">Milestone {i + 1}</span>
              <ItemControls
                idBase={`${idBase}-${it.id}`}
                noun="Milestone"
                name={it.label}
                index={i}
                count={items.length}
                onMove={(to) => onChange({ ...block, items: move(items, i, to) })}
                onRemove={items.length > 1 ? () => onChange({ ...block, items: items.filter((x) => x.id !== it.id) }) : undefined}
                removeLabel="Remove"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input id={`${idBase}-${it.id}-label`} label="Label" required fieldClassName="sm:col-span-2" value={it.label} onChange={(e) => onChange({ ...block, items: items.map((x) => (x.id === it.id ? { ...x, label: e.target.value } : x)) })} />
              <Input id={`${idBase}-${it.id}-date`} label="Date" hint="YYYY-MM or YYYY-MM-DD" value={it.date ?? ""} onChange={(e) => onChange({ ...block, items: items.map((x) => (x.id === it.id ? { ...x, date: e.target.value } : x)) })} />
            </div>
            <Textarea id={`${idBase}-${it.id}-detail`} label="Detail" rows={2} fieldClassName="mt-3" value={it.detail ?? ""} onChange={(e) => onChange({ ...block, items: items.map((x) => (x.id === it.id ? { ...x, detail: e.target.value } : x)) })} />
          </li>
        ))}
      </ol>
      <div>
        <Button variant="secondary" size="sm" onClick={() => onChange({ ...block, items: [...items, { id: newId("itm"), label: "" }] })}>
          Add milestone
        </Button>
      </div>
    </>
  );
}

function DecisionEditor({ block, onChange, idBase }: Edit<Of<"decision">>) {
  const options = block.options;
  return (
    <>
      <Input id={`${idBase}-statement`} label="Decision" required value={block.statement} onChange={(e) => onChange({ ...block, statement: e.target.value })} />
      <Textarea id={`${idBase}-rationale`} label="Rationale" rows={3} value={block.rationale ?? ""} onChange={(e) => onChange({ ...block, rationale: e.target.value })} />
      {options.length ? (
        <ol className="flex flex-col gap-3">
          {options.map((o, i) => (
            <li key={o.id} className="rounded-md border border-line p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={o.chosen}
                    onChange={(e) => onChange({ ...block, options: options.map((x) => (x.id === o.id ? { ...x, chosen: e.target.checked } : x)) })}
                  />
                  Chosen option
                </label>
                <ItemControls
                  idBase={`${idBase}-${o.id}`}
                  noun="Option"
                  name={o.label}
                  index={i}
                  count={options.length}
                  onMove={(to) => onChange({ ...block, options: move(options, i, to) })}
                  onRemove={() => onChange({ ...block, options: options.filter((x) => x.id !== o.id) })}
                  removeLabel="Remove"
                />
              </div>
              <Input id={`${idBase}-${o.id}-label`} label="Option" required value={o.label} onChange={(e) => onChange({ ...block, options: options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })} />
              <Textarea id={`${idBase}-${o.id}-desc`} label="Description" rows={2} fieldClassName="mt-3" value={o.description ?? ""} onChange={(e) => onChange({ ...block, options: options.map((x) => (x.id === o.id ? { ...x, description: e.target.value } : x)) })} />
            </li>
          ))}
        </ol>
      ) : null}
      <div>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={options.length >= 8 || undefined}
          onClick={() => options.length < 8 && onChange({ ...block, options: [...options, { id: newId("itm"), label: "", chosen: false }] })}
        >
          Add option
        </Button>
      </div>
    </>
  );
}

function RiskEditor({ block, onChange, idBase }: Edit<Of<"risk">>) {
  return (
    <>
      <Select
        id={`${idBase}-kind`}
        label="Kind"
        value={block.kind}
        onChange={(e) => onChange({ ...block, kind: e.target.value as Of<"risk">["kind"] })}
        options={[
          { value: "risk", label: "Risk" },
          { value: "assumption", label: "Assumption" },
          { value: "uncertainty", label: "Uncertainty" },
          { value: "tradeoff", label: "Tradeoff" },
        ]}
      />
      <Input id={`${idBase}-statement`} label="Statement" required value={block.statement} onChange={(e) => onChange({ ...block, statement: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select id={`${idBase}-likelihood`} label="Likelihood" value={block.likelihood ?? ""} onChange={(e) => onChange({ ...block, likelihood: (e.target.value || undefined) as Of<"risk">["likelihood"] })} options={LEVELS} />
        <Select id={`${idBase}-impact`} label="Impact" value={block.impact ?? ""} onChange={(e) => onChange({ ...block, impact: (e.target.value || undefined) as Of<"risk">["impact"] })} options={LEVELS} />
      </div>
      <Textarea id={`${idBase}-mitigation`} label="Mitigation" rows={2} value={block.mitigation ?? ""} onChange={(e) => onChange({ ...block, mitigation: e.target.value })} />
    </>
  );
}

function ActionEditor({ block, onChange, idBase }: Edit<Of<"action">>) {
  return (
    <>
      <Input id={`${idBase}-statement`} label="Action" required value={block.statement} onChange={(e) => onChange({ ...block, statement: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id={`${idBase}-owner`} label="Owner" value={block.owner ?? ""} onChange={(e) => onChange({ ...block, owner: e.target.value })} />
        <Input id={`${idBase}-due`} label="Due" hint="YYYY-MM or YYYY-MM-DD" value={block.dueDate ?? ""} onChange={(e) => onChange({ ...block, dueDate: e.target.value })} />
      </div>
    </>
  );
}

/** Evidence references for a block: attach an evidence item (any status) with an optional note. */
function EvidenceRefsEditor({ block, onChange, idBase, evidence }: Edit<Block> & { evidence: EvidenceItem[] }) {
  const [pick, setPick] = useState("");
  const refs = block.evidenceRefs;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const available = evidence.filter((e) => !refs.some((r) => r.evidenceId === e.id));
  const statusText = (e?: EvidenceItem) => (!e ? "missing" : e.status === "approved" ? "approved" : e.status === "excluded" ? "excluded, will not publish" : "candidate, not yet approved");
  return (
    <div className="rounded-md bg-subtle p-3">
      <p className="text-sm font-medium text-ink">Supporting evidence</p>
      {refs.length ? (
        <ul className="mt-2 flex flex-col gap-2">
          {refs.map((r, i) => {
            const e = byId.get(r.evidenceId);
            return (
              <li key={`${r.evidenceId}-${i}`} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {e?.title ?? r.evidenceId} <span className="text-muted">({statusText(e)})</span>
                  </p>
                  <Input
                    id={`${idBase}-ref-${i}-note`}
                    label="What it supports (optional)"
                    fieldClassName="mt-1"
                    value={r.note ?? ""}
                    onChange={(ev) => onChange({ ...block, evidenceRefs: refs.map((x, k) => (k === i ? { ...x, note: ev.target.value } : x)) })}
                  />
                </div>
                <Button variant="ghost" size="sm" className="text-danger" aria-label={`Detach ${e?.title ?? "evidence"}`} onClick={() => onChange({ ...block, evidenceRefs: refs.filter((_, k) => k !== i) })}>
                  Detach
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted">No evidence attached. This claim will publish without evidence.</p>
      )}
      {available.length ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Select
            id={`${idBase}-attach`}
            label="Attach evidence"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            options={[{ value: "", label: "Choose evidence…" }, ...available.map((e) => ({ value: e.id, label: `${e.title} (${statusText(e)})` }))]}
          />
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={!pick || undefined}
            onClick={() => {
              if (!pick) return;
              onChange({ ...block, evidenceRefs: [...refs, { evidenceId: pick }] });
              setPick("");
            }}
          >
            Attach
          </Button>
        </div>
      ) : evidence.length === 0 ? (
        <p className="mt-1 text-xs text-muted">Add evidence in the Evidence group below to attach it here.</p>
      ) : null}
    </div>
  );
}

export function BlockEditor({ block, onChange, idBase, evidence }: Edit<Block> & { evidence: EvidenceItem[] }) {
  const typed = (() => {
    switch (block.type) {
      case "narrative":
        return <NarrativeEditor block={block} onChange={onChange} idBase={idBase} />;
      case "key_finding":
        return <KeyFindingEditor block={block} onChange={onChange} idBase={idBase} />;
      case "metric":
        return <MetricEditor block={block} onChange={onChange} idBase={idBase} />;
      case "comparison":
        return <ComparisonEditor block={block} onChange={onChange} idBase={idBase} />;
      case "chart":
        return <ChartEditor block={block} onChange={onChange} idBase={idBase} />;
      case "timeline":
        return <TimelineEditor block={block} onChange={onChange} idBase={idBase} />;
      case "decision":
        return <DecisionEditor block={block} onChange={onChange} idBase={idBase} />;
      case "risk":
        return <RiskEditor block={block} onChange={onChange} idBase={idBase} />;
      case "action":
        return <ActionEditor block={block} onChange={onChange} idBase={idBase} />;
    }
  })();
  return (
    <div className="flex flex-col gap-4">
      {typed}
      <EvidenceRefsEditor block={block} onChange={onChange} idBase={idBase} evidence={evidence} />
    </div>
  );
}
