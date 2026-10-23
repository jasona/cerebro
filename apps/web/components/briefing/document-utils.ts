/**
 * Document helpers shared by the editor (client) and the New brief page
 * (server): templates, new-block factories and pre-save cleanup. Pure; no
 * server-only imports.
 */
import {
  GAP_PLACEHOLDERS,
  GAP_PREFIX,
  newId,
  SCHEMA_VERSION,
  type Block,
  type BlockType,
  type BriefingDocument,
} from "@cerebro/briefing-schema/client";

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  narrative: "Narrative",
  key_finding: "Key finding",
  metric: "Metric",
  comparison: "Comparison",
  chart: "Chart",
  timeline: "Timeline",
  decision: "Decision",
  risk: "Risk, assumption or tradeoff",
  action: "Action",
};

export const BLOCK_TYPE_ORDER: BlockType[] = ["narrative", "key_finding", "metric", "comparison", "chart", "timeline", "decision", "risk", "action"];

/**
 * A minimal valid draft. Required text uses the schema's gap placeholders, so
 * the issues list flags every field the author still has to state; nothing
 * is invented.
 */
export function blankDocument(title?: string): BriefingDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: title?.trim() || GAP_PLACEHOLDERS.title,
    kind: "strategy",
    position: { headline: GAP_PLACEHOLDERS.headline, summary: GAP_PLACEHOLDERS.summary },
    context: { stakes: GAP_PLACEHOLDERS.stakes },
    request: { type: "decision", statement: GAP_PLACEHOLDERS.request },
    sections: [
      {
        id: newId("sec"),
        title: "The recommendation",
        blocks: [{ id: newId("blk"), type: "narrative", role: "general", text: `${GAP_PREFIX}explain the recommendation.`, evidenceRefs: [] }],
      },
    ],
    perspectives: [],
    evidence: [],
    openQuestions: [],
  };
}

export function newBlock(type: BlockType): Block {
  const base = { id: newId("blk"), evidenceRefs: [] };
  switch (type) {
    case "narrative":
      return { ...base, type, role: "general", text: "" };
    case "key_finding":
      return { ...base, type, statement: "" };
    case "metric":
      return { ...base, type, label: "", value: 0, unit: "" };
    case "comparison":
      return { ...base, type, columns: ["Option", "Notes"], rows: [{ label: "", cells: ["", ""] }] };
    case "chart":
      return {
        ...base,
        type,
        title: "",
        kind: "bar",
        altText: "",
        series: [{ label: "Series 1", points: [{ x: "Category 1", y: 0 }] }],
      };
    case "timeline":
      return { ...base, type, items: [{ id: newId("itm"), label: "" }] };
    case "decision":
      return { ...base, type, statement: "", options: [] };
    case "risk":
      return { ...base, type, kind: "risk", statement: "" };
    case "action":
      return { ...base, type, statement: "" };
  }
}

/** Keys whose empty string means "not set" and must be removed before validation. */
const OPTIONAL_KEYS = new Set([
  "detail",
  "background",
  "dueDate",
  "asOf",
  "caption",
  "attribution",
  "locator",
  "owner",
  "mitigation",
  "audience",
  "description",
  "note",
  "context",
  "rationale",
  "date",
  "likelihood",
  "impact",
]);

function cleanValue(value: unknown, parentType?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => cleanValue(v));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : parentType;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === "" || v === undefined) {
        // Optional block titles (comparison, timeline) are "not set" when empty; a chart title is required.
        if (OPTIONAL_KEYS.has(k) || (k === "title" && (type === "comparison" || type === "timeline"))) continue;
      }
      if (typeof v === "string" && OPTIONAL_KEYS.has(k) && v.trim() === "") continue;
      out[k] = cleanValue(v, type);
    }
    return out;
  }
  return value;
}

/** Strip empty optional fields so the server validates what the author actually set. */
export function cleanDocument(doc: BriefingDocument): BriefingDocument {
  return cleanValue(doc) as BriefingDocument;
}
