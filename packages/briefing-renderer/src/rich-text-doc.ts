import { parseInline, safeHref, splitParagraphs, type InlineNode } from "./rich-text";

/*
 * Conversion between the briefing RichText string syntax and the ProseMirror
 * JSON used by the studio's rich-text editor (Tiptap).
 *
 * The string stays the stored and published format. The editor schema is
 * limited to what the syntax can express: paragraphs (blank-line separated),
 * hard breaks (single newlines), and bold, italic and http(s) link marks.
 *
 * - `richTextToEditorDoc` uses the renderer's own parser, so the editor shows
 *   exactly what readers will see.
 * - `editorDocToRichText` writes canonical syntax: links outermost, then bold,
 *   then italic. Re-parsing its output yields the same editor document.
 *
 * Plain JSON in, plain JSON out: no editor dependency, safe on the server.
 */

export type EditorMark = { type: "bold" } | { type: "italic" } | { type: "link"; attrs: { href: string } & Record<string, unknown> };

export interface EditorTextNode {
  type: "text";
  text: string;
  marks?: EditorMark[];
}
export interface EditorHardBreakNode {
  type: "hardBreak";
  marks?: EditorMark[];
}
export type EditorInlineNode = EditorTextNode | EditorHardBreakNode;
export interface EditorParagraphNode {
  type: "paragraph";
  content?: EditorInlineNode[];
}
export interface EditorDoc {
  type: "doc";
  content: EditorParagraphNode[];
}

interface Active {
  bold: boolean;
  italic: boolean;
  href: string | null;
}

function marksFor(a: Active): EditorMark[] | undefined {
  const marks: EditorMark[] = [];
  if (a.href) marks.push({ type: "link", attrs: { href: a.href } });
  if (a.bold) marks.push({ type: "bold" });
  if (a.italic) marks.push({ type: "italic" });
  return marks.length ? marks : undefined;
}

function sameMarks(a: EditorMark[] | undefined, b: EditorMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function flatten(nodes: InlineNode[], active: Active, out: EditorInlineNode[]) {
  for (const n of nodes) {
    switch (n.type) {
      case "text": {
        n.text.split("\n").forEach((line, i) => {
          if (i > 0) out.push({ type: "hardBreak" });
          if (!line) return;
          const marks = marksFor(active);
          const prev = out[out.length - 1];
          // Merge adjacent runs with identical marks (e.g. "**a****b**").
          if (prev?.type === "text" && sameMarks(prev.marks, marks)) prev.text += line;
          else out.push(marks ? { type: "text", text: line, marks } : { type: "text", text: line });
        });
        break;
      }
      case "strong":
        flatten(n.children, { ...active, bold: true }, out);
        break;
      case "em":
        flatten(n.children, { ...active, italic: true }, out);
        break;
      case "link":
        flatten(n.children, { ...active, href: n.href }, out);
        break;
    }
  }
}

/** Parse a RichText string into an editor document (always at least one paragraph). */
export function richTextToEditorDoc(text: string): EditorDoc {
  const paragraphs = splitParagraphs(text).map((p): EditorParagraphNode => {
    const content: EditorInlineNode[] = [];
    flatten(parseInline(p), { bold: false, italic: false, href: null }, content);
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  });
  return { type: "doc", content: paragraphs.length ? paragraphs : [{ type: "paragraph" }] };
}

// ---------------------------------------------------------------------------
// Editor document → RichText
// ---------------------------------------------------------------------------

type Run = { kind: "text"; text: string; bold: boolean; italic: boolean; href: string | null } | { kind: "break" };

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
/** The link syntax accepts URLs without whitespace and with balanced, unnested parentheses. */
const LINK_URL = /^(?:[^()\s]|\([^()\s]*\))+$/;

function linkTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const href = safeHref(raw);
  if (!href) return null;
  if (LINK_URL.test(href)) return href;
  const encoded = href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
  return LINK_URL.test(encoded) ? encoded : null;
}

function toRuns(content: EditorInlineNode[] | undefined): Run[] {
  const runs: Run[] = [];
  for (const node of content ?? []) {
    if (node.type === "hardBreak") {
      runs.push({ kind: "break" });
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = node.marks ?? [];
    const link = marks.find((m): m is Extract<EditorMark, { type: "link" }> => m.type === "link");
    runs.push({
      kind: "text",
      // Newlines inside text are not produced by the editor; treat them as spaces.
      text: node.text.replace(/\r?\n/g, " "),
      bold: marks.some((m) => m.type === "bold"),
      italic: marks.some((m) => m.type === "italic"),
      href: link ? linkTarget(link.attrs?.href) : null,
    });
  }
  return runs;
}

type TextRun = Extract<Run, { kind: "text" }>;

/**
 * Group consecutive runs that share `key`. A break stays inside a group when
 * the text on both sides shares the key (so "**a\nb**" keeps one bold span),
 * unless `breaksSplit` (link labels cannot contain newlines).
 */
function group<K>(runs: Run[], key: (r: TextRun) => K, breaksSplit = false): { key: K | null; runs: Run[] }[] {
  const keys = runs.map((r, i): { k: K | null } => {
    if (r.kind === "text") return { k: key(r) };
    if (breaksSplit) return { k: null };
    const prev = runs.slice(0, i).reverse().find((x): x is TextRun => x.kind === "text");
    const next = runs.slice(i + 1).find((x): x is TextRun => x.kind === "text");
    return prev && next && key(prev) === key(next) ? { k: key(prev) } : { k: null };
  });
  const groups: { key: K | null; runs: Run[] }[] = [];
  runs.forEach((r, i) => {
    const k = keys[i]!.k;
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.runs.push(r);
    else groups.push({ key: k, runs: [r] });
  });
  return groups;
}

const plain = (runs: Run[]) => runs.map((r) => (r.kind === "break" ? "\n" : r.text)).join("");

function writeItalic(runs: Run[]): string {
  const groups = group(runs, (r) => r.italic);
  return groups
    .map((g, i) => {
      const text = plain(g.runs);
      if (!g.key) return text;
      // `_x_` only parses as italic at word boundaries, with no `_` closing it early.
      const before = groups[i - 1] ? plain(groups[i - 1]!.runs).slice(-1) : undefined;
      const after = groups[i + 1] ? plain(groups[i + 1]!.runs)[0] : undefined;
      const closesEarly = /_(?![\p{L}\p{N}])/u.test(text.slice(0, -1)) || text.endsWith("_");
      if (isWord(before) || isWord(after) || closesEarly) return text;
      return `_${text}_`;
    })
    .join("");
}

function writeBold(runs: Run[]): string {
  return group(runs, (r) => r.bold)
    .map((g) => (g.key ? `**${writeItalic(g.runs)}**` : writeItalic(g.runs)))
    .join("");
}

function writeLinks(runs: Run[]): string {
  return group(runs, (r) => r.href, true)
    .map((g) => {
      if (!g.key) return writeBold(g.runs);
      const label = writeBold(g.runs);
      // A label cannot contain "]" in the link syntax; keep the text, drop the target.
      return label.includes("]") ? label : `[${label}](${g.key})`;
    })
    .join("");
}

/**
 * Serialise an editor document to canonical RichText. Empty paragraphs are
 * dropped; an empty document is the empty string.
 */
export function editorDocToRichText(doc: EditorDoc | { content?: unknown }): string {
  const paragraphs = Array.isArray(doc.content) ? (doc.content as EditorParagraphNode[]) : [];
  return paragraphs
    .filter((p) => p?.type === "paragraph")
    .map((p) => writeLinks(toRuns(p.content)).trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A comparison key for editor documents that ignores editor-only attributes
 * (e.g. a link's `target`). Two documents with the same key render the same.
 */
export function editorDocKey(doc: EditorDoc | { content?: unknown }): string {
  const paragraphs = Array.isArray(doc.content) ? (doc.content as EditorParagraphNode[]) : [];
  return JSON.stringify(
    paragraphs.map((p) =>
      (p.content ?? []).map((n) => [
        n.type,
        n.type === "text" ? n.text : "",
        (n.type === "text" ? (n.marks ?? []) : []).map((m) => (m.type === "link" ? `link:${String(m.attrs?.href)}` : m.type)).sort(),
      ]),
    ),
  );
}
