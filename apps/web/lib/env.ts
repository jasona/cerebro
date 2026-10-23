import "server-only";
import { resolveAuthMode, type AuthMode } from "./auth-mode";

export type { AuthMode };

/**
 * Resolved identity adapter (see auth-mode.ts). `dev` is the default only
 * outside production; production without an explicit AUTH_MODE fails closed
 * to `clerk`, and AUTH_MODE=dev in production throws, so the dev user picker
 * can never be enabled there.
 */
export function authMode(): AuthMode {
  return resolveAuthMode(process.env);
}

export const isDevAuth = (): boolean => authMode() === "dev";

/** Canonical base URL without a trailing slash. */
export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
