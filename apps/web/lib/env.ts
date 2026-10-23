import "server-only";

export type AuthMode = "dev" | "clerk";

/**
 * Resolved identity adapter. `dev` is the default only outside production;
 * production without an explicit AUTH_MODE fails closed to `clerk`, so the dev
 * user picker can never be enabled by omission. (Dev sessions in production
 * additionally require SESSION_SECRET, see session-token.ts.)
 */
export function authMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim().toLowerCase();
  if (raw === "clerk") return "clerk";
  if (raw === "dev") return "dev";
  return process.env.NODE_ENV === "production" ? "clerk" : "dev";
}

export const isDevAuth = (): boolean => authMode() === "dev";

/** Canonical base URL without a trailing slash. */
export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
