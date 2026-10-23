import type { Block, BlockType, BriefingDocument } from "@cerebro/briefing-schema";
import { collectIds, seededIds } from "../ids";
import { blockText } from "../retrieval";
import type { SuggestedPerspective, SuggestPerspectivesInput, SuggestPerspectivesOutput } from "../tasks";

/**
 * Rule-based perspective suggestions for the offline provider.
 *
 * Each "lens" is a common executive audience tied to block types the draft
 * already contains (decisions, figures, risks, actions, findings). A lens
 * applies only when the draft has such blocks; its emphasis is the sections
 * holding them and its implications quote those blocks verbatim. No prose is
 * invented, no fact is added, and the rationale says plainly that the
 * suggestion is rule-based. The author still decides whether to adopt it.
 */
interface Lens {
  label: string;
  audience: string;
  types: readonly BlockType[];
  focus: string;
}

const LENSES: readonly Lens[] = [
  { label: "Decision makers", audience: "Leaders asked to decide", types: ["decision"], focus: "the decision, the options considered and the recommendation" },
  { label: "Finance", audience: "Finance leadership", types: ["metric", "chart", "comparison"], focus: "the figures, comparisons and tradeoffs" },
  { label: "Risk review", audience: "Risk and assurance reviewers", types: ["risk"], focus: "the risks, assumptions, uncertainties and tradeoffs" },
  { label: "Delivery", audience: "Teams delivering the plan", types: ["action", "timeline"], focus: "the actions, owners and timeline" },
  { label: "Evidence review", audience: "Readers checking the evidence", types: ["key_finding"], focus: "the findings and the evidence behind them" },
];

const MAX_IMPLICATIONS = 3;
const MAX_PERSPECTIVES = 8;

/** A short, verbatim statement of a block for use as an implication. */
function quote(block: Block): string {
  let text: string;
  switch (block.type) {
    case "decision": {
      const chosen = block.options.find((o) => o.chosen);
      text = chosen ? `${block.statement} Recommended option: ${chosen.label}.` : block.statement;
      break;
    }
    case "key_finding":
      text = block.statement;
      break;
    case "chart":
      text = block.altText || block.title;
      break;
    case "comparison":
      text = block.title || blockText(block).split("\n")[0] || "";
      break;
    case "timeline":
      text = blockText(block).split("\n").slice(0, 3).join(" ");
      break;
    default:
      text = blockText(block).split("\n")[0] ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function joinTitles(titles: string[]): string {
  const q = titles.map((t) => `“${t}”`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

export function suggestPerspectivesDeterministic(input: SuggestPerspectivesInput): SuggestPerspectivesOutput {
  const doc: BriefingDocument = input.document;
  const room = Math.max(0, MAX_PERSPECTIVES - doc.perspectives.length);
  const limit = Math.min(input.maxSuggestions, room);
  if (limit === 0) {
    return { suggestions: [], notes: "This briefing already has the maximum number of perspectives." };
  }
  const existing = new Set(doc.perspectives.map((p) => p.label.trim().toLowerCase()));
  const ids = seededIds(`suggest|${input.baseVersion ?? ""}|${doc.title}`, collectIds(doc));

  const suggestions: SuggestedPerspective[] = [];
  for (const lens of LENSES) {
    if (suggestions.length >= limit) break;
    if (existing.has(lens.label.toLowerCase())) continue;
    const sections = doc.sections.filter((s) => s.blocks.some((b) => lens.types.includes(b.type)));
    if (!sections.length) continue;
    const blocks = sections.flatMap((s) => s.blocks.filter((b) => lens.types.includes(b.type)));
    const implications = blocks
      .map((b) => ({ block: b, text: quote(b) }))
      .filter((x) => x.text.length > 0)
      .slice(0, MAX_IMPLICATIONS)
      .map((x) => ({ id: ids("itm"), text: x.text, blockIds: [x.block.id] }));
    suggestions.push({
      perspective: {
        id: ids("psp"),
        label: lens.label,
        audience: lens.audience,
        summary: `For ${lens.audience.toLowerCase()}: the same briefing, read with emphasis on ${lens.focus} in ${joinTitles(sections.map((s) => s.title))}.`.slice(0, 2000),
        emphasis: sections.map((s) => s.id),
        implications,
      },
      rationale:
        `Rule-based suggestion from the local deterministic provider (no model). The draft contains ${lens.types.map((t) => t.replace("_", " ")).join(" or ")} blocks, ` +
        `so a reading focused on ${lens.focus} may help ${lens.audience.toLowerCase()}. Implications quote the draft verbatim; rewrite them in your own words before publishing.`,
    });
  }

  return suggestions.length
    ? { suggestions }
    : { suggestions: [], notes: "No rule-based suggestions apply: the draft has no further block types that map to a common audience, or those perspectives already exist." };
}
