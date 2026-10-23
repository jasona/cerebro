import { z } from "zod";
import { BriefingDocument } from "./document";
import { HandoffPackage } from "./handoff";

/**
 * JSON Schemas (draft 2020-12) for MCP tool input schemas. Generated in
 * `input` mode, so fields with schema defaults are optional — matching what
 * a host may send before Cerebro applies defaults.
 */
export function briefingDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BriefingDocument, { io: "input" }) as Record<string, unknown>;
}

export function handoffJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(HandoffPackage, { io: "input" }) as Record<string, unknown>;
}
