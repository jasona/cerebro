import { BriefingDocument, SCHEMA_VERSION, type BriefingDocumentInput } from "./document";
import { GAP_PLACEHOLDERS } from "./gaps";
import { NO_EVIDENCE_GAP, addGap, clamp, createContext, type ComposeContext, type ComposeOptions } from "./compose-util";

export interface MarkdownToDocumentOptions extends ComposeOptions {
  /** Title used when the Markdown has no `#` heading. A `#` heading always wins. */
  title?: string;
}

export interface ComposedDocument {
  document: BriefingDocument;
  /** Human-readable content gaps: missing request, stakes, evidence, shortened text, … */
  gaps: string[];
}

type RiskKind = "risk" | "assumption" | "uncertainty" | "tradeoff";
type RequestType = "decision" | "approval" | "input" | "awareness";

type Item =
  | { kind: "para"; text: string }
  | { kind: "action"; text: string }
  | { kind: "risk"; riskKind: RiskKind; text: string }
  | { kind: "request"; type: RequestType; text: string };

interface RawSection {
  title: string;
  items: Item[];
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TASK = /^\s*[-*+]\s+\[ \]\s+(.*)$/;
const LABELLED = /^(?:\*\*|__)?([A-Za-z][A-Za-z -]{1,20}?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/;

const RISK_LABELS: Record<string, RiskKind> = {
  risk: "risk",
  assumption: "assumption",
  uncertainty: "uncertainty",
  tradeoff: "tradeoff",
  "trade-off": "tradeoff",
};
const ACTION_LABELS = new Set(["action", "next step", "todo"]);
const REQUEST_LABELS: Record<string, RequestType> = {
  decision: "decision",
  approval: "approval",
  approve: "approval",
  request: "input",
  ask: "input",
  input: "input",
};

function classify(line: string): Item | undefined {
  const task = TASK.exec(line);
  if (task?.[1]) return { kind: "action", text: task[1] };
  const stripped = line.replace(LIST_MARKER, "");
  const m = LABELLED.exec(stripped.trim());
  if (!m?.[1] || !m[2]) return undefined;
  const label = m[1].trim().toLowerCase();
  const text = m[2].replace(/(?:\*\*|__)\s*$/, "").trim();
  if (!text) return undefined;
  if (ACTION_LABELS.has(label)) return { kind: "action", text };
  const riskKind = RISK_LABELS[label];
  if (riskKind) return { kind: "risk", riskKind, text };
  const requestType = REQUEST_LABELS[label];
  if (requestType) return { kind: "request", type: requestType, text };
  return undefined;
}

/** Extracts `owner: X` and `due: YYYY-MM[-DD]` only when written; never infers them. */
export function parseActionLine(text: string): { statement: string; owner?: string; dueDate?: string } {
  let statement = text;
  let owner: string | undefined;
  let dueDate: string | undefined;
  const ownerRe = /\b(?:owner|assignee)\s*:\s*([^,;()[\]—–]+?)\s*(?=$|[,;)\]—–]|\bdue\b)/i;
  const om = ownerRe.exec(statement);
  if (om?.[1]) {
    owner = om[1].trim();
    statement = statement.replace(om[0], " ");
  }
  const dueRe = /\b(?:due|by)\s*:?\s*(\d{4}-\d{2}(?:-\d{2})?)\b/i;
  const dm = dueRe.exec(statement);
  if (dm?.[1]) {
    dueDate = dm[1];
    statement = statement.replace(dm[0], " ");
  }
  statement = statement
    .replace(/\(\s*[,;]?\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s,;—–-]+$/, "")
    .replace(/\(\s*$/, "")
    .trim();
  const out: { statement: string; owner?: string; dueDate?: string } = { statement: statement || text.trim() };
  if (owner) out.owner = owner;
  if (dueDate) out.dueDate = dueDate;
  return out;
}

function parse(markdown: string): { title?: string; preamble: Item[]; sections: RawSection[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title: string | undefined;
  const preamble: Item[] = [];
  const sections: RawSection[] = [];
  let target = preamble;
  let buffer: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) target.push({ kind: "para", text });
    buffer = [];
  };

  for (const line of lines) {
    if (fence) {
      buffer.push(line);
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const fenceOpen = /^\s*(```|~~~)/.exec(line);
    if (fenceOpen?.[1]) {
      fence = fenceOpen[1];
      buffer.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      if (!text) continue;
      if (level === 1 && title === undefined && sections.length === 0) {
        title = text;
      } else if (level <= 2) {
        const section: RawSection = { title: text, items: [] };
        sections.push(section);
        target = section.items;
      } else {
        target.push({ kind: "para", text: `**${text}**` });
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const item = classify(line);
    if (item) {
      flush();
      target.push(item);
      continue;
    }
    buffer.push(line);
  }
  flush();
  const out: { title?: string; preamble: Item[]; sections: RawSection[] } = { preamble, sections };
  if (title !== undefined) out.title = title;
  return out;
}

const WHY_NOW = /^(why now|why it matters|why this matters|stakes|context)\b/i;
const RATIONALE = /^(rationale|why this|reasoning)\b/i;
const ALTERNATIVES = /\balternatives?\b|\boptions\b/i;

function firstSentence(text: string): string | undefined {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.replace(/\s+/g, " ").trim());
  return m?.[1];
}

/**
 * Deterministic Markdown → draft document. No model, no invented content.
 *
 * - `#` → title (else `opts.title`); the first paragraph before any `##` → position summary.
 * - Further paragraphs before the first `##` → an "Overview" section.
 * - `##` → sections; paragraphs → narrative blocks (`###` and deeper become bold lines).
 * - `- [ ] …`, `Action: …`, `Next step: …` → action blocks (`owner:` / `due:` parsed only when written).
 * - `Risk:`, `Assumption:`, `Uncertainty:`, `Tradeoff:` → risk blocks.
 * - `Decision:` / `Approval:` → the request plus a decision block; `Request:` / `Ask:` → an input request.
 * - A "Why now" / "Stakes" / "Context" section's first paragraph also becomes `context.stakes`.
 *
 * Missing title, position, stakes, request and evidence are returned as gaps and
 * filled with clearly marked placeholders (see `GAP_PLACEHOLDERS`).
 */
export function markdownToDocument(markdown: string, opts: MarkdownToDocumentOptions = {}): ComposedDocument {
  const ctx = createContext(opts);
  const raw = parse(markdown);

  const titleSource = raw.title ?? opts.title?.trim();
  let title: string;
  if (titleSource) {
    title = clamp(ctx, titleSource, 200, "The title");
  } else {
    title = GAP_PLACEHOLDERS.title;
    addGap(ctx, "No title was given (add a `#` heading).");
  }

  // Position summary: first preamble paragraph.
  const preamble = [...raw.preamble];
  const firstParaIndex = preamble.findIndex((i) => i.kind === "para");
  let summary: string;
  if (firstParaIndex >= 0) {
    const [first] = preamble.splice(firstParaIndex, 1);
    summary = clamp(ctx, (first as { text: string }).text, 20_000, "The position summary");
  } else {
    summary = GAP_PLACEHOLDERS.summary;
    addGap(ctx, "No position summary was given (add a paragraph under the title).");
  }

  let headline: string;
  if (titleSource) headline = clamp(ctx, titleSource, 500, "The headline");
  else {
    const sentence = summary === GAP_PLACEHOLDERS.summary ? undefined : firstSentence(summary);
    if (sentence && sentence.length <= 500) headline = sentence;
    else {
      headline = GAP_PLACEHOLDERS.headline;
      addGap(ctx, "No position headline was given.");
    }
  }

  const rawSections: RawSection[] = [];
  if (preamble.length) rawSections.push({ title: "Overview", items: preamble });
  rawSections.push(...raw.sections);
  if (rawSections.length > 30) {
    addGap(ctx, `The Markdown has ${rawSections.length} sections; only the first 30 were kept.`);
    rawSections.length = 30;
  }

  let stakes: string | undefined;
  let request: BriefingDocumentInput["request"] | undefined;
  const sections: BriefingDocumentInput["sections"] = rawSections.map((rs) => {
    const sectionTitle = clamp(ctx, rs.title, 500, `Section title "${rs.title.slice(0, 40)}"`);
    const role = WHY_NOW.test(rs.title)
      ? "context"
      : RATIONALE.test(rs.title)
        ? "rationale"
        : ALTERNATIVES.test(rs.title)
          ? "alternative"
          : "general";
    const blocks = buildBlocks(ctx, rs, role, (text) => {
      if (role === "context" && stakes === undefined) stakes = text;
    }, (type, text) => {
      if (!request) request = { type, statement: text };
    });
    if (blocks.length > 60) {
      addGap(ctx, `Section "${sectionTitle}" has ${blocks.length} blocks; only the first 60 were kept.`);
      blocks.length = 60;
    }
    return { id: ctx.ids("sec"), title: sectionTitle, blocks };
  });

  if (stakes === undefined) addGap(ctx, "Why this matters now was not stated (add a \"Why now\" section).");
  if (!request) {
    addGap(ctx, "No request was stated (add a `Decision:` or `Request:` line); the request defaults to awareness.");
  }

  const input: BriefingDocumentInput = {
    schemaVersion: SCHEMA_VERSION,
    title,
    position: { headline, summary },
    context: { stakes: stakes ?? GAP_PLACEHOLDERS.stakes },
    request: request ?? { type: "awareness", statement: GAP_PLACEHOLDERS.request },
    sections,
    perspectives: [],
    evidence: [],
    openQuestions: [],
  };
  addGap(ctx, NO_EVIDENCE_GAP);
  return { document: BriefingDocument.parse(input), gaps: ctx.gaps };
}

type NarrativeRole = "context" | "rationale" | "alternative" | "general";

function buildBlocks(
  ctx: ComposeContext,
  rs: RawSection,
  role: NarrativeRole,
  onParagraph: (text: string) => void,
  onRequest: (type: RequestType, text: string) => void,
): BriefingDocumentInput["sections"][number]["blocks"] {
  const blocks: BriefingDocumentInput["sections"][number]["blocks"] = [];
  for (const item of rs.items) {
    switch (item.kind) {
      case "para": {
        const text = clamp(ctx, item.text, 20_000, `A paragraph in "${rs.title}"`);
        onParagraph(text);
        blocks.push({ id: ctx.ids("blk"), type: "narrative", role, text });
        break;
      }
      case "action": {
        const parsed = parseActionLine(item.text);
        const block: BriefingDocumentInput["sections"][number]["blocks"][number] = {
          id: ctx.ids("blk"),
          type: "action",
          statement: clamp(ctx, parsed.statement, 500, "An action"),
        };
        if (parsed.owner) block.owner = clamp(ctx, parsed.owner, 120, "An action owner");
        if (parsed.dueDate) block.dueDate = parsed.dueDate;
        blocks.push(block);
        break;
      }
      case "risk":
        blocks.push({
          id: ctx.ids("blk"),
          type: "risk",
          kind: item.riskKind,
          statement: clamp(ctx, item.text, 500, `A ${item.riskKind}`),
        });
        break;
      case "request": {
        const statement = clamp(ctx, item.text, 500, "The request");
        onRequest(item.type, statement);
        if (item.type === "decision" || item.type === "approval") {
          blocks.push({ id: ctx.ids("blk"), type: "decision", statement });
        }
        break;
      }
    }
  }
  return blocks;
}
