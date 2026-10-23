/**
 * Tool result helpers. Every tool returns both `structuredContent` (stable,
 * machine-readable) and a concise `content` text for hosts that only show
 * text. Errors carry a stable `code` and set `isError: true`.
 */
import { isDomainError } from "@cerebro/domain";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolErrorCode =
  | "ambiguous_destination"
  | "unauthenticated"
  | "expired"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "stale_preview"
  | "idempotency_mismatch"
  | "rate_limited"
  | "unavailable"
  | "validation";

/** Convert Dates (and other JSON-able values) to plain JSON. */
export function toJson<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: toJson(structured) };
}

export function fail(code: ToolErrorCode, message: string, details?: Record<string, unknown>, hint?: string): CallToolResult {
  const text = [`Error (${code}): ${message}`, hint].filter(Boolean).join("\n");
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: toJson({ status: "error", error: { code, message, ...(details ? { details } : {}) } }),
  };
}

const HINTS: Partial<Record<ToolErrorCode, string>> = {
  conflict:
    "The draft changed since you loaded it. Nothing was overwritten. Call get_brief with view \"draft\" to load the current version, reapply the change, and retry with the new expected_version.",
  stale_preview:
    "The brief changed (or the preview expired or was used) after this preview. Call preview_brief again, show the user the new preview, and publish only if they ask again.",
  idempotency_mismatch:
    "This idempotency_key was already used for a different request. Use a new key for a new request; reuse a key only to retry the identical request.",
  unauthenticated: "The Cerebro connection is invalid, expired or revoked. Ask the user to reconnect Cerebro; never ask for credentials in the conversation.",
  forbidden: "The connected account is not allowed to do this.",
  not_found: "It does not exist in this company, or the connected account cannot see it.",
  rate_limited: "Too many requests. Wait before retrying.",
  unavailable: "Cerebro could not complete the request. It is safe to retry with the same idempotency_key.",
  validation: "Fix the listed issues and retry. Do not invent content, evidence or numbers to clear them.",
};

/** Map any thrown error to a tool error result. Never echoes request content. */
export function toToolError(e: unknown): CallToolResult {
  if (isDomainError(e)) {
    const code: ToolErrorCode = e.code === "ambiguous" ? "ambiguous_destination" : e.code;
    return fail(code, e.message, e.details, HINTS[code]);
  }
  return fail("unavailable", "Unexpected server error.", undefined, HINTS.unavailable);
}
