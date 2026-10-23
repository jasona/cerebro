import type { Block } from "@cerebro/briefing-schema/client";
import { cn } from "@cerebro/ui";
import type { ReactNode } from "react";
import { formatNumber, formatValue } from "./format";

type ChartBlock = Extract<Block, { type: "chart" }>;

/* Series are distinguished by text labels, marker shape and dash pattern, never colour alone. */
const SERIES_FILL = ["fill-accent", "fill-ink", "fill-chart-muted", "fill-info", "fill-success", "fill-warning", "fill-danger", "fill-muted"];
const SERIES_STROKE = ["stroke-accent", "stroke-ink", "stroke-muted", "stroke-info", "stroke-success", "stroke-warning", "stroke-danger", "stroke-chart-muted"];
const SERIES_DASH = [undefined, "6 4", "2 3", "10 3 2 3", undefined, "6 4", "2 3", "10 3 2 3"];

function categories(block: ChartBlock): string[] {
  const seen: string[] = [];
  for (const s of block.series) for (const p of s.points) if (!seen.includes(p.x)) seen.push(p.x);
  return seen;
}

function valueAt(series: ChartBlock["series"][number], x: string): number | undefined {
  return series.points.find((p) => p.x === x)?.y;
}

function domain(block: ChartBlock): [number, number] {
  const ys = block.series.flatMap((s) => s.points.map((p) => p.y));
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0, ...ys);
  return hi === lo ? [lo, lo + 1] : [lo, hi];
}

function Marker({ shape, x, y, className }: { shape: number; x: number; y: number; className: string }) {
  switch (shape % 4) {
    case 1:
      return <rect x={x - 4} y={y - 4} width={8} height={8} className={className} />;
    case 2:
      return <path d={`M${x} ${y - 5}L${x + 5} ${y + 4}H${x - 5}Z`} className={className} />;
    case 3:
      return <path d={`M${x} ${y - 5}L${x + 5} ${y}L${x} ${y + 5}L${x - 5} ${y}Z`} className={className} />;
    default:
      return <circle cx={x} cy={y} r={4} className={className} />;
  }
}

const WIDTH = 640;

function barGeometry(block: ChartBlock) {
  const bar = 18;
  const barGap = 6;
  const groupGap = 14;
  const n = block.series.length;
  const groupH = n * bar + (n - 1) * barGap;
  const groups = categories(block).length;
  return { bar, barGap, groupGap, groupH, height: groups * groupH + (groups - 1) * groupGap + 8 };
}

function BarChart({ block }: { block: ChartBlock }) {
  const xs = categories(block);
  const multi = block.series.length > 1;
  const label = 150;
  const valueRoom = multi ? 150 : 80;
  const area = WIDTH - label - valueRoom;
  const { bar, barGap, groupGap, groupH, height } = barGeometry(block);
  const [lo, hi] = domain(block);
  const scale = (v: number) => ((v - lo) / (hi - lo)) * area;
  const zero = label + scale(0);

  return (
    <>
      {xs.map((x, gi) => {
        const top = gi * (groupH + groupGap) + 4;
        return (
          <g key={x}>
            <text x={0} y={top + groupH / 2} dominantBaseline="middle" className="fill-fg text-[14px]">
              {x.length > 22 ? `${x.slice(0, 21)}…` : x}
            </text>
            {block.series.map((s, si) => {
              const v = valueAt(s, x);
              if (v === undefined) return null;
              const y = top + si * (bar + barGap);
              const start = Math.min(zero, label + scale(v));
              const w = Math.max(1, Math.abs(label + scale(v) - zero));
              return (
                <g key={s.label}>
                  <rect x={start} y={y} width={w} height={bar} rx={2} className={SERIES_FILL[si % SERIES_FILL.length]} />
                  <text x={label + area + 8} y={y + bar / 2} dominantBaseline="middle" className="fill-fg text-[14px] tabular-nums">
                    {multi ? `${s.label}: ` : ""}
                    {formatValue(v, block.unit)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
      {lo < 0 ? <line x1={zero} x2={zero} y1={0} y2={height} className="stroke-line-strong" /> : null}
    </>
  );
}

const LINE_H = 260;
const PAD = { top: 16, right: 120, bottom: 36, left: 56 };

function LineChart({ block }: { block: ChartBlock }) {
  const xs = categories(block);
  const [lo, hi] = domain(block);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = LINE_H - PAD.top - PAD.bottom;
  const px = (i: number) => PAD.left + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const py = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = [lo, (lo + hi) / 2, hi];
  const labelEvery = Math.max(1, Math.ceil(xs.length / 8));

  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={PAD.left + plotW} y1={py(t)} y2={py(t)} className="stroke-line" />
          <text x={PAD.left - 8} y={py(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[12px] tabular-nums">
            {formatValue(Number(t.toPrecision(3)), block.unit)}
          </text>
        </g>
      ))}
      {xs.map((x, i) =>
        i % labelEvery === 0 || i === xs.length - 1 ? (
          <text key={x} x={px(i)} y={LINE_H - PAD.bottom + 20} textAnchor="middle" className="fill-muted text-[12px]">
            {x}
          </text>
        ) : null,
      )}
      {block.series.map((s, si) => {
        const pts = xs
          .map((x, i) => {
            const v = valueAt(s, x);
            return v === undefined ? null : { x: px(i), y: py(v) };
          })
          .filter((p): p is { x: number; y: number } => p !== null);
        const last = pts[pts.length - 1];
        const stroke = SERIES_STROKE[si % SERIES_STROKE.length]!;
        const fill = SERIES_FILL[si % SERIES_FILL.length]!;
        return (
          <g key={s.label}>
            <polyline
              points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              strokeWidth={2}
              strokeDasharray={SERIES_DASH[si % SERIES_DASH.length]}
              strokeLinejoin="round"
              className={stroke}
            />
            {pts.map((p, i) => (
              <Marker key={i} shape={si} x={p.x} y={p.y} className={fill} />
            ))}
            {last ? (
              <text x={last.x + 10} y={last.y} dominantBaseline="middle" className="fill-fg text-[12px] font-medium">
                {s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

export interface ChartDataTableProps {
  block: ChartBlock;
  className?: string;
}

/** Tabular alternative for a chart; always rendered alongside the graphic. */
export function ChartDataTable({ block, className }: ChartDataTableProps) {
  const xs = categories(block);
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Data for {block.title}</caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="py-2 pr-4 font-medium text-ink">
              Category
            </th>
            {block.series.map((s) => (
              <th key={s.label} scope="col" className="py-2 pr-4 text-right font-medium text-ink">
                {s.label}
                {block.unit ? <span className="font-normal text-muted"> ({block.unit})</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {xs.map((x) => (
            <tr key={x} className="border-b border-line">
              <th scope="row" className="py-2 pr-4 font-normal text-fg">
                {x}
              </th>
              {block.series.map((s) => {
                const v = valueAt(s, x);
                return (
                  <td key={s.label} className="py-2 pr-4 text-right tabular-nums">
                    {v === undefined ? <span className="text-muted">No value</span> : formatNumber(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ChartProps {
  block: ChartBlock;
  /** Appended after the caption, e.g. evidence markers. */
  trailing?: ReactNode;
}

export function Chart({ block, trailing }: ChartProps) {
  const titleId = `${block.id}-chart-title`;
  const descId = `${block.id}-chart-desc`;
  const height = block.kind === "bar" ? barGeometry(block).height : LINE_H;
  return (
    <figure className="my-0">
      <figcaption id={titleId} className="mb-3 font-medium text-ink">
        {block.title}
      </figcaption>
      <svg
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        className="block h-auto w-full max-w-[640px] overflow-visible font-sans"
      >
        {block.kind === "bar" ? <BarChart block={block} /> : <LineChart block={block} />}
      </svg>
      {block.series.length > 1 ? (
        <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {block.series.map((s, si) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <svg width="18" height="10" viewBox="0 0 18 10">
                <line x1="0" x2="18" y1="5" y2="5" strokeWidth="2" strokeDasharray={block.kind === "line" ? SERIES_DASH[si % SERIES_DASH.length] : undefined} className={SERIES_STROKE[si % SERIES_STROKE.length]} />
                <Marker shape={block.kind === "line" ? si : 1} x={9} y={5} className={SERIES_FILL[si % SERIES_FILL.length]!} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <p id={descId} className="mt-3 text-sm text-muted">
        <span className="font-medium text-fg">Chart summary: </span>
        {block.altText}
      </p>
      {block.caption || trailing ? (
        <p className="mt-1 text-sm text-muted">
          {block.caption}
          {trailing ? <> {trailing}</> : null}
        </p>
      ) : null}
      <details className="mt-3 group/details">
        <summary className="cursor-pointer text-sm font-medium text-accent underline-offset-2 hover:underline">
          Show data table
        </summary>
        <ChartDataTable block={block} className="mt-2" />
      </details>
    </figure>
  );
}
