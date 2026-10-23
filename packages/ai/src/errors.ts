/**
 * Error categories recorded on AI runs. Categories are coarse on purpose: they
 * are safe to log and aggregate, and never carry prompt or passage text.
 */
export const ERROR_CATEGORIES = [
  "timeout",
  "aborted",
  "unavailable",
  "policy_denied",
  "provider_error",
  "invalid_input",
  "invalid_output",
  "unsupported",
] as const;
export type AiErrorCategory = (typeof ERROR_CATEGORIES)[number];

export class AiError extends Error {
  readonly category: AiErrorCategory;

  constructor(category: AiErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiError";
    this.category = category;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
