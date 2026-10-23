import { collectIds, seededIds, type IdFactory } from "../ids";
import type { ProposeRevisionInput, ProposeRevisionOutput } from "../tasks";

export const UNSUPPORTED_INSTRUCTION =
  "unsupported instruction for the local provider; edit manually or configure a model";

const ADD_PERSPECTIVE = /\badd\s+(?:an?\s+|another\s+)?(?:new\s+)?perspective\s+(?:for|on|from|aimed at|targeting)\s+(?:the\s+)?(.+?)\s*[.!]?$/i;
const TIGHTEN = /\b(tighten|shorten|condense|trim|make (?:it )?(?:shorter|tighter|more concise))\b/i;

/**
 * Deterministic revision proposals. Only instructions that can be handled
 * without writing prose are supported; everything else is reported as
 * unsupported rather than approximated.
 */
export function proposeRevisionDeterministic(input: ProposeRevisionInput, opts: { ids?: IdFactory } = {}): ProposeRevisionOutput {
  const instruction = input.instruction.trim();
  const base = input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {};

  const add = ADD_PERSPECTIVE.exec(instruction);
  if (add) {
    const audience = add[1]!.replace(/\s+perspective$/i, "").trim().slice(0, 200);
    const label = toLabel(audience);
    const existing = input.document.perspectives.find((p) => p.label.toLowerCase() === label.toLowerCase());
    if (existing) {
      return {
        status: "no_change",
        scope: `Perspective "${existing.label}" already exists.`,
        explanation: "A perspective with this label already exists; edit it instead of adding a duplicate.",
        operations: [],
        gaps: [],
        ...base,
      };
    }
    if (input.document.perspectives.length >= 8) {
      return {
        status: "no_change",
        scope: "Perspectives",
        explanation: "A briefing can hold at most 8 perspectives; remove one before adding another.",
        operations: [],
        gaps: [],
        ...base,
      };
    }
    const ids = opts.ids ?? seededIds(`${instruction}|${input.baseVersion ?? ""}`, collectIds(input.document));
    const id = ids("psp");
    return {
      status: "proposed",
      scope: `Adds an empty "${label}" perspective scaffold. No content is changed.`,
      explanation:
        "The local provider does not write perspective content. The author (or the connected LLM, as author-written content) must supply its summary, emphasis and implications before publishing.",
      operations: [
        { op: "add_perspective", perspective: { id, label, audience, summary: "", emphasis: [], implications: [] } },
      ],
      gaps: [
        {
          kind: "empty_perspective",
          message: `Perspective "${label}" is an empty scaffold; write what this audience should take from the brief.`,
          path: `perspectives.${input.document.perspectives.length}`,
        },
      ],
      ...base,
    };
  }

  if (TIGHTEN.test(instruction)) {
    return {
      status: "no_change",
      scope: "No changes.",
      explanation:
        "The local provider does not rewrite prose, so tightening was not attempted and nothing was changed. Edit the text manually or configure an approved model.",
      operations: [],
      gaps: [],
      ...base,
    };
  }

  return { status: "unsupported", scope: "No changes.", explanation: UNSUPPORTED_INSTRUCTION, operations: [], gaps: [], ...base };
}

function toLabel(audience: string): string {
  const label = audience
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return label.slice(0, 60) || "New perspective";
}
