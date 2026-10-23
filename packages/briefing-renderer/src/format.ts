const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** "124%", "$2.4", "3.1 months". Symbol-like units attach without a space. */
export function formatValue(value: number, unit?: string): string {
  const n = formatNumber(value);
  if (!unit) return n;
  if (unit === "%" || unit === "pp" || unit === "x" || unit === "×") return `${n}${unit}`;
  if (unit === "$" || unit === "€" || unit === "£" || unit === "¥") return `${unit}${n}`;
  return `${n} ${unit}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Formats YYYY-MM or YYYY-MM-DD (and ISO timestamps) without timezone drift. */
export function formatDate(iso: string, style: "short" | "month" = "short"): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const month = Number(mo) - 1;
  if (month < 0 || month > 11) return iso;
  if (style === "month" || !d) return `${(style === "month" ? MONTHS_LONG : MONTHS)[month]} ${y}`;
  return `${MONTHS[month]} ${Number(d)}, ${y}`;
}
