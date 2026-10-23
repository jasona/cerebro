export type DomainErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "stale_preview"
  | "validation"
  | "idempotency_mismatch"
  | "ambiguous"
  | "unauthenticated"
  | "rate_limited"
  | "unavailable";

/**
 * Error raised by domain services. Unauthorized reads use `not_found` so that
 * protected titles, counts and identifiers are never disclosed.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
