import { z } from "zod";

/**
 * JSON Schema for structured outputs (`output_config.format`).
 *
 * The task output schemas are richer than the subset structured outputs
 * accept, so this keeps the supported keywords (type, enum, const, anyOf,
 * allOf, $ref/$defs, properties, required, items, supported string formats,
 * `minItems` 0 or 1), forces `additionalProperties: false` on every object,
 * and moves every other constraint (lengths, patterns, numeric bounds, larger
 * item counts) into the node's description so the model still sees it. The
 * caller validates the result against the full Zod schema, so nothing the
 * subset cannot express is lost: it is checked after the response instead.
 */

const SUPPORTED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const KEEP = new Set(["type", "enum", "const", "$ref", "required", "description", "title"]);
const DROP = new Set(["$schema", "$id", "additionalProperties", "default", "examples"]);

type JsonNode = Record<string, unknown>;

function isSafeIntegerBound(key: string, value: unknown): boolean {
  return (
    (key === "minimum" && value === Number.MIN_SAFE_INTEGER) || (key === "maximum" && value === Number.MAX_SAFE_INTEGER)
  );
}

function strict(node: unknown): JsonNode {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return {};
  const out: JsonNode = {};
  const extra: JsonNode = {};
  for (const [key, value] of Object.entries(node as JsonNode)) {
    if (DROP.has(key) || isSafeIntegerBound(key, value)) continue;
    if (KEEP.has(key)) out[key] = value;
    else if (key === "$defs" || key === "properties") {
      out[key] = Object.fromEntries(Object.entries(value as JsonNode).map(([k, v]) => [k, strict(v)]));
    } else if (key === "anyOf" || key === "oneOf") out.anyOf = (value as unknown[]).map(strict);
    else if (key === "allOf") out.allOf = (value as unknown[]).map(strict);
    else if (key === "items") out.items = strict(value);
    else if (key === "format" && typeof value === "string" && SUPPORTED_FORMATS.has(value)) out.format = value;
    else if (key === "minItems" && (value === 0 || value === 1)) out.minItems = value;
    else extra[key] = value;
  }
  if (out.type === "object" || out.properties !== undefined) {
    out.properties ??= {};
    out.additionalProperties = false;
  }
  if (Object.keys(extra).length > 0) {
    const note = `Constraints: ${JSON.stringify(extra)}`;
    out.description = typeof out.description === "string" && out.description ? `${out.description}\n\n${note}` : note;
  }
  return out;
}

/** Structured-output JSON Schema for a task's output schema. Deterministic for a given schema, so it caches server-side. */
export function structuredOutputSchema(schema: z.ZodType): JsonNode {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", unrepresentable: "any", reused: "ref", cycles: "ref" });
  return strict(json);
}
