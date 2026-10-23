import "server-only";
import { notFound, redirect } from "next/navigation";
import { isDomainError, retryAfterSeconds, type DomainErrorCode } from "@cerebro/domain";
import type { ActionState, SafeErrorDetails } from "./action-state";

/** User-facing copy for each domain error code. Never echoes protected data. */
const MESSAGES: Record<DomainErrorCode, string> = {
  not_found: "We couldn't find that, or you don't have access to it.",
  forbidden: "You don't have permission to do that.",
  conflict: "Someone else changed this at the same time. Reload and try again.",
  stale_preview: "The draft changed since this preview was created. Review the latest preview before publishing.",
  validation: "Some of the information provided isn't valid.",
  idempotency_mismatch: "This request was already used for a different action. Start again.",
  ambiguous: "That matches more than one option. Choose a specific one.",
  unauthenticated: "Your session has expired. Sign in again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  unavailable: "This service is temporarily unavailable. Your work has not been lost; try again shortly.",
};

/** HTTP status for API routes. `not_found` is also used for unauthorized reads. */
export const HTTP_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  stale_preview: 409,
  validation: 422,
  idempotency_mismatch: 422,
  ambiguous: 409,
  unauthenticated: 401,
  rate_limited: 429,
  unavailable: 503,
};

export function errorMessage(code: DomainErrorCode, details?: unknown): string {
  const retry = code === "rate_limited" ? retryAfterSeconds(details) : undefined;
  return retry ? `Too many attempts. Try again in ${retry} second${retry === 1 ? "" : "s"}.` : MESSAGES[code];
}

const MAX_ISSUES = 50;
const MAX_REASONS = 20;
const short = (v: unknown, n: number): string | null => (typeof v === "string" && v.length ? v.slice(0, n) : null);

/**
 * Pick the safe subset of DomainError details: `issues` (path and message
 * only), `currentVersion` and `reasons`. Any other key, and any unexpected
 * shape, is dropped so nothing protected reaches the browser.
 */
export function safeErrorDetails(details: unknown): SafeErrorDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const out: SafeErrorDetails = {};
  if (Array.isArray(d.issues)) {
    const issues = d.issues.slice(0, MAX_ISSUES).flatMap((i): { path?: string; message: string }[] => {
      if (typeof i === "string") return [{ message: i.slice(0, 500) }];
      if (!i || typeof i !== "object") return [];
      const message = short((i as { message?: unknown }).message, 500);
      if (!message) return [];
      const path = short((i as { path?: unknown }).path, 200);
      return [path ? { path, message } : { message }];
    });
    if (issues.length) out.issues = issues;
  }
  if (typeof d.currentVersion === "number" && Number.isInteger(d.currentVersion)) out.currentVersion = d.currentVersion;
  if (Array.isArray(d.reasons)) {
    const reasons = d.reasons.slice(0, MAX_REASONS).flatMap((r) => (typeof r === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(r) ? [r] : []));
    if (reasons.length) out.reasons = reasons;
  }
  const retry = retryAfterSeconds(d);
  if (retry) out.retryAfterSeconds = retry;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Map an error from a domain call into an ActionState. Validation messages
 * from the domain are shown because they describe the caller's own input;
 * other codes use fixed copy so nothing protected can leak. Only the safe
 * details (`issues`, `currentVersion`, `reasons`) are kept. Non-domain errors
 * are rethrown (Next redirect/notFound control flow must propagate).
 */
export function toActionError(err: unknown): Extract<ActionState, { status: "error" }> {
  if (isDomainError(err)) {
    const message =
      err.code === "validation" || err.code === "conflict" || err.code === "ambiguous" || err.code === "forbidden"
        ? err.message || MESSAGES[err.code]
        : errorMessage(err.code, err.details);
    const details = safeErrorDetails(err.details);
    return details ? { status: "error", code: err.code, message, details } : { status: "error", code: err.code, message };
  }
  throw err;
}

/**
 * For page (server component) data loading: not_found → 404 page,
 * unauthenticated → sign-in, everything else rethrown to the error boundary
 * (which shows the mapped message via `digest`-free copy).
 */
export function handlePageError(err: unknown, signInNext?: string): never {
  if (isDomainError(err)) {
    if (err.code === "not_found") notFound();
    if (err.code === "unauthenticated") redirect(signInNext ? `/sign-in?next=${encodeURIComponent(signInNext)}` : "/sign-in");
  }
  throw err;
}

/** Run a page loader, mapping domain errors via handlePageError. */
export async function loadOrThrow<T>(fn: () => Promise<T>, signInNext?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    handlePageError(err, signInNext);
  }
}

/**
 * Run a server-action body, converting DomainErrors to an error ActionState.
 * `fn` returns the success state (or nothing for a plain "Saved.").
 */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { status: "ok", message: "Saved." };
  } catch (err) {
    return toActionError(err);
  }
}

/** Read a required string field from FormData (trimmed); empty → "". */
export const field = (fd: FormData, name: string): string => {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
};
