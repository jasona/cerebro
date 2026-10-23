import { BriefingDocument } from "@cerebro/briefing-schema";
import { AiError } from "./errors";
import type { RevisionOperation } from "./tasks";

/**
 * Apply proposed operations to a document copy and re-validate the result.
 * Pure: the domain layer still applies the outcome through the normal draft
 * update path with its optimistic-concurrency check (`baseVersion`).
 */
export function applyRevisionOperations(doc: BriefingDocument, operations: readonly RevisionOperation[]): BriefingDocument {
  const next = structuredClone(doc);
  for (const op of operations) {
    switch (op.op) {
      case "add_perspective":
        if (next.perspectives.some((p) => p.id === op.perspective.id)) throw new AiError("invalid_output", "duplicate perspective id");
        next.perspectives.push(op.perspective);
        break;
      case "update_perspective": {
        const i = next.perspectives.findIndex((p) => p.id === op.perspective.id);
        if (i < 0) throw new AiError("invalid_output", "unknown perspective id");
        next.perspectives[i] = op.perspective;
        break;
      }
      case "add_block": {
        const section = next.sections.find((s) => s.id === op.sectionId);
        if (!section) throw new AiError("invalid_output", "unknown section id");
        const at = op.afterBlockId ? section.blocks.findIndex((b) => b.id === op.afterBlockId) + 1 : section.blocks.length;
        if (op.afterBlockId && at === 0) throw new AiError("invalid_output", "unknown afterBlockId");
        section.blocks.splice(at, 0, op.block);
        break;
      }
      case "replace_block": {
        let found = false;
        for (const s of next.sections) {
          const i = s.blocks.findIndex((b) => b.id === op.block.id);
          if (i >= 0) {
            s.blocks[i] = op.block;
            found = true;
          }
        }
        if (!found) throw new AiError("invalid_output", "unknown block id");
        break;
      }
      case "remove_block": {
        let found = false;
        for (const s of next.sections) {
          const before = s.blocks.length;
          s.blocks = s.blocks.filter((b) => b.id !== op.blockId);
          found ||= s.blocks.length !== before;
        }
        if (!found) throw new AiError("invalid_output", "unknown block id");
        break;
      }
      case "set_text": {
        const [head, field] = op.path.split(".") as [string, string | undefined];
        if (!field) (next as Record<string, unknown>)[head] = op.value;
        else ((next as unknown as Record<string, Record<string, unknown>>)[head]!)[field] = op.value;
        break;
      }
    }
  }
  const parsed = BriefingDocument.safeParse(next);
  if (!parsed.success) throw new AiError("invalid_output", "operations produce an invalid document");
  return parsed.data;
}
