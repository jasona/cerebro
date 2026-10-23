import type { Block, BriefingDocument } from "@cerebro/briefing-schema/client";
import { richTextToPlain } from "./rich-text";

function blockText(block: Block): string[] {
  switch (block.type) {
    case "narrative":
      return [richTextToPlain(block.text)];
    case "key_finding":
      return [block.statement, block.detail ? richTextToPlain(block.detail) : ""];
    case "metric":
      return [block.label, String(block.value), block.unit, block.context ?? "", block.comparison?.label ?? ""];
    case "comparison":
      return [block.title ?? "", ...block.columns, ...block.rows.flatMap((r) => [r.label, ...r.cells])];
    case "chart":
      return [block.title, block.altText, block.caption ?? ""];
    case "timeline":
      return [block.title ?? "", ...block.items.flatMap((i) => [i.label, i.detail ?? ""])];
    case "decision":
      return [block.statement, ...block.options.flatMap((o) => [o.label, o.description ?? ""]), block.rationale ? richTextToPlain(block.rationale) : ""];
    case "risk":
      return [block.statement, block.mitigation ?? ""];
    case "action":
      return [block.statement, block.owner ?? ""];
    default:
      return [];
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Words in the canonical argument (evidence excerpts and perspectives excluded). */
export function briefingWordCount(document: BriefingDocument): number {
  const parts = [
    document.position.headline,
    richTextToPlain(document.position.summary),
    richTextToPlain(document.context.stakes),
    document.context.background ? richTextToPlain(document.context.background) : "",
    document.request.statement,
    document.request.detail ? richTextToPlain(document.request.detail) : "",
    ...document.sections.flatMap((s) => [s.title, ...s.blocks.flatMap(blockText)]),
    ...document.openQuestions.map((q) => q.text),
  ];
  return parts.reduce((n, p) => n + countWords(p), 0);
}

/**
 * Estimated reading time in whole minutes (minimum 1). Adds a fixed allowance
 * per chart/table, since data takes longer to read than prose.
 */
export function estimateReadingMinutes(document: BriefingDocument, wordsPerMinute = 230): number {
  const visuals = document.sections.flatMap((s) => s.blocks).filter((b) => b.type === "chart" || b.type === "comparison").length;
  const seconds = (briefingWordCount(document) / wordsPerMinute) * 60 + visuals * 10;
  return Math.max(1, Math.round(seconds / 60));
}

export function formatReadingTime(minutes: number): string {
  return `${minutes} min read`;
}
