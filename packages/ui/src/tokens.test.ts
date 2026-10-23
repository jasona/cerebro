/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(source: string, start: number): string {
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error("unbalanced CSS");
}

function hexTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--cb-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = hexTokens(block(css, css.indexOf(":root {")));
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const dark = { ...light, ...hexTokens(block(css, darkStart)) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [foreground, background, minimum ratio] */
const pairs: Array<[string, string, number]> = [
  ["ink", "background", 4.5],
  ["foreground", "background", 4.5],
  ["foreground", "surface", 4.5],
  ["foreground", "muted", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "surface", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["accent", "background", 4.5],
  ["accent", "surface", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["accent-foreground", "accent-hover", 4.5],
  ["accent-ink", "accent-soft", 4.5],
  ["ink", "accent-soft", 4.5],
  ["accent", "accent-soft", 3],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["info", "info-soft", 4.5],
  ["danger-foreground", "danger", 4.5],
  ["danger", "background", 4.5],
  // Non-text UI components (WCAG 1.4.11)
  ["focus", "background", 3],
  ["border-strong", "background", 3],
  ["border-strong", "surface", 3],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme contrast", (_name, tokens) => {
  it.each(pairs)("%s on %s ≥ %d", (fg, bg, min) => {
    expect(tokens[fg], `missing --cb-${fg}`).toBeDefined();
    expect(tokens[bg], `missing --cb-${bg}`).toBeDefined();
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

describe("tokens.css", () => {
  it("applies the same dark palette for the OS preference and an explicit data-theme", () => {
    const explicit = css.indexOf(':root[data-theme="dark"]');
    expect(explicit).toBeGreaterThan(-1);
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(hexTokens(block(css, explicit))).toEqual(hexTokens(block(css, darkStart)));
  });
  it("exposes overridable font families", () => {
    expect(css).toMatch(/--font-serif:\s*"Source Serif 4", "Iowan Old Style"/);
    expect(css).toMatch(/--font-sans:\s*"Inter", system-ui/);
  });
  it("respects reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
