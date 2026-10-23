import type { Block } from "@cerebro/briefing-schema/client";
import { Badge, cn } from "@cerebro/ui";
import type { ReactNode } from "react";
import { Chart } from "./chart";
import type { RenderContext } from "./context";
import { EvidenceMarkers } from "./evidence";
import { formatDate, formatValue } from "./format";
import { RichText } from "./rich-text";

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;

export interface BlockProps<T extends Block["type"]> {
  block: Of<T>;
  ctx: RenderContext;
}

const eyebrow = "text-xs font-medium tracking-[0.12em] text-muted uppercase";

function Markers({ block, ctx }: { block: Block; ctx: RenderContext }) {
  return <EvidenceMarkers refs={block.evidenceRefs} blockId={block.id} ctx={ctx} />;
}

function Time({ iso, style }: { iso: string; style?: "short" | "month" }) {
  return <time dateTime={iso}>{formatDate(iso, style)}</time>;
}

const NARRATIVE_LABEL: Record<Of<"narrative">["role"], string | null> = {
  general: null,
  context: null,
  rationale: "Rationale",
  alternative: "Alternative considered",
};

export function NarrativeBlockView({ block, ctx }: BlockProps<"narrative">) {
  const label = NARRATIVE_LABEL[block.role];
  return (
    <div className={cn(block.role === "alternative" && "border-l-2 border-line-strong pl-4")}>
      {label ? <p className={cn(eyebrow, "mb-2")}>{label}</p> : null}
      <RichText text={block.text} className="text-[1.0625rem] leading-relaxed text-fg" trailing={<Markers block={block} ctx={ctx} />} />
    </div>
  );
}

export function KeyFindingBlockView({ block, ctx }: BlockProps<"key_finding">) {
  return (
    <div className="border-l-2 border-accent pl-4">
      <p className={eyebrow}>Key finding</p>
      <p className="mt-1 font-serif text-xl leading-snug text-ink">
        {block.statement} <Markers block={block} ctx={ctx} />
      </p>
      {block.detail ? <RichText text={block.detail} className="mt-2 leading-relaxed text-fg" /> : null}
    </div>
  );
}

export function MetricBlockView({ block, ctx }: BlockProps<"metric">) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <dl>
        <dt className="text-sm font-medium text-muted">{block.label}</dt>
        <dd className="mt-1 font-serif text-4xl leading-none text-ink tabular-nums">
          {formatValue(block.value, block.unit)} <Markers block={block} ctx={ctx} />
        </dd>
        {block.asOf ? (
          <dd className="mt-2 text-sm text-muted">
            As of <Time iso={block.asOf} />
          </dd>
        ) : null}
        {block.comparison ? (
          <dd className="mt-1 text-sm text-fg">
            Compared with {block.comparison.label}: <span className="tabular-nums">{formatValue(block.comparison.value, block.unit)}</span>
          </dd>
        ) : null}
      </dl>
      {block.context ? <p className="mt-3 text-sm leading-relaxed text-fg">{block.context}</p> : null}
    </div>
  );
}

export function ComparisonBlockView({ block, ctx }: BlockProps<"comparison">) {
  const caption = block.title ?? "Comparison";
  return (
    <div>
      <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-focus">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="px-4 pt-4 pb-2 text-left font-medium text-ink">
            {caption} <Markers block={block} ctx={ctx} />
          </caption>
          <thead>
            <tr className="border-b border-line-strong bg-subtle">
              <th scope="col" className="px-4 py-2 font-medium text-ink">
                <span className="sr-only">Item</span>
              </th>
              {block.columns.map((c, i) => (
                <th key={i} scope="col" className="px-4 py-2 font-medium text-ink">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-3 align-top font-medium text-ink">
                  {row.label}
                </th>
                {block.columns.map((_, ci) => (
                  <td key={ci} className="px-4 py-3 align-top text-fg">
                    {row.cells[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ChartBlockView({ block, ctx }: BlockProps<"chart">) {
  return <Chart block={block} trailing={<Markers block={block} ctx={ctx} />} />;
}

export function TimelineBlockView({ block, ctx }: BlockProps<"timeline">) {
  return (
    <div>
      {block.title ? (
        <h3 className="mb-3 font-medium text-ink">
          {block.title} <Markers block={block} ctx={ctx} />
        </h3>
      ) : null}
      <ol className="relative ml-2 border-l border-line-strong">
        {block.items.map((item) => (
          <li key={item.id} id={item.id} className="relative mb-5 pl-6 last:mb-0">
            <span aria-hidden="true" className="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-accent bg-paper" />
            {item.date ? (
              <p className="text-sm font-medium text-muted">
                <Time iso={item.date} />
              </p>
            ) : null}
            <p className="font-medium text-ink">{item.label}</p>
            {item.detail ? <p className="mt-1 text-sm leading-relaxed text-fg">{item.detail}</p> : null}
          </li>
        ))}
      </ol>
      {!block.title ? (
        <p className="mt-2">
          <Markers block={block} ctx={ctx} />
        </p>
      ) : null}
    </div>
  );
}

export function DecisionBlockView({ block, ctx }: BlockProps<"decision">) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <p className={eyebrow}>Decision</p>
      <h3 className="mt-1 font-serif text-xl leading-snug text-ink">
        {block.statement} <Markers block={block} ctx={ctx} />
      </h3>
      {block.options.length ? (
        <ul className="mt-4 flex flex-col gap-2">
          {block.options.map((o) => (
            <li
              key={o.id}
              id={o.id}
              className={cn("rounded-md border px-4 py-3", o.chosen ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-fg")}
            >
              <div className="flex flex-wrap items-center gap-2">
                {o.chosen ? (
                  <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" className="shrink-0 fill-none stroke-current" strokeWidth="2">
                    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
                <span className="font-medium text-ink">{o.label}</span>
                {o.chosen ? <Badge tone="accent">Chosen</Badge> : <span className="text-sm text-muted">Considered</span>}
              </div>
              {o.description ? <p className="mt-1 text-sm leading-relaxed">{o.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {block.rationale ? (
        <div className="mt-4">
          <p className={cn(eyebrow, "mb-1")}>Rationale</p>
          <RichText text={block.rationale} className="leading-relaxed text-fg" />
        </div>
      ) : null}
    </div>
  );
}

const RISK_LABEL: Record<Of<"risk">["kind"], string> = {
  risk: "Risk",
  assumption: "Assumption",
  uncertainty: "Uncertainty",
  tradeoff: "Tradeoff",
};
const RISK_TONE = { risk: "danger", assumption: "info", uncertainty: "warning", tradeoff: "neutral" } as const;
const LEVEL = { low: "Low", medium: "Medium", high: "High" } as const;

export function RiskBlockView({ block, ctx }: BlockProps<"risk">) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <Badge tone={RISK_TONE[block.kind]}>{RISK_LABEL[block.kind]}</Badge>
      <p className="mt-2 leading-relaxed font-medium text-ink">
        {block.statement} <Markers block={block} ctx={ctx} />
      </p>
      {block.likelihood || block.impact || block.mitigation ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {block.likelihood ? (
            <>
              <dt className="text-muted">Likelihood</dt>
              <dd className="text-fg">{LEVEL[block.likelihood]}</dd>
            </>
          ) : null}
          {block.impact ? (
            <>
              <dt className="text-muted">Impact</dt>
              <dd className="text-fg">{LEVEL[block.impact]}</dd>
            </>
          ) : null}
          {block.mitigation ? (
            <>
              <dt className="text-muted">{block.kind === "risk" ? "Mitigation" : "Response"}</dt>
              <dd className="text-fg">{block.mitigation}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

export function ActionBlockView({ block, ctx }: BlockProps<"action">) {
  return (
    <div className="flex gap-3 rounded-lg border border-line bg-surface p-4">
      <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-sm border-2 border-accent" />
      <div>
        <p className="sr-only">Action:</p>
        <p className="font-medium text-ink">
          {block.statement} <Markers block={block} ctx={ctx} />
        </p>
        {block.owner || block.dueDate ? (
          <dl className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted">
            {block.owner ? (
              <div className="flex gap-1">
                <dt>Owner:</dt>
                <dd className="text-fg">{block.owner}</dd>
              </div>
            ) : null}
            {block.dueDate ? (
              <div className="flex gap-1">
                <dt>Due:</dt>
                <dd className="text-fg">
                  <Time iso={block.dueDate} />
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

/** Renders any block by type. Unknown types render nothing rather than raw data. */
export function BlockContent({ block, ctx }: { block: Block; ctx: RenderContext }): ReactNode {
  switch (block.type) {
    case "narrative":
      return <NarrativeBlockView block={block} ctx={ctx} />;
    case "key_finding":
      return <KeyFindingBlockView block={block} ctx={ctx} />;
    case "metric":
      return <MetricBlockView block={block} ctx={ctx} />;
    case "comparison":
      return <ComparisonBlockView block={block} ctx={ctx} />;
    case "chart":
      return <ChartBlockView block={block} ctx={ctx} />;
    case "timeline":
      return <TimelineBlockView block={block} ctx={ctx} />;
    case "decision":
      return <DecisionBlockView block={block} ctx={ctx} />;
    case "risk":
      return <RiskBlockView block={block} ctx={ctx} />;
    case "action":
      return <ActionBlockView block={block} ctx={ctx} />;
    default:
      return null;
  }
}

/** A block with its deep-link anchor, preview annotation and app-supplied actions. */
export function BlockFrame({ block, ctx }: { block: Block; ctx: RenderContext }) {
  const annotation = ctx.annotations?.[block.id];
  const actions = ctx.renderBlockActions?.(block);
  return (
    <div id={block.id} data-block-type={block.type} className="group/block relative scroll-mt-24">
      {annotation ? (
        <div role="note" className="mb-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          {annotation}
        </div>
      ) : null}
      <BlockContent block={block} ctx={ctx} />
      {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
