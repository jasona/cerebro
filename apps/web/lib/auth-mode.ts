/**
 * Identity adapter selection (D08). Pure, so `proxy.ts`, server code and tests
 * share one rule:
 *
 * - `AUTH_MODE=clerk` uses Clerk.
 * - `AUTH_MODE=dev` enables the dev sign-in, and is REFUSED (throws) when
 *   NODE_ENV=production. There is no override: the dev user picker must never
 *   run in production.
 * - Unset defaults to `dev` outside production and fails closed to `clerk` in
 *   production, so the dev picker can never be enabled by omission.
 */
export type AuthMode = "dev" | "clerk";

export class AuthModeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthModeConfigError";
  }
}

export function resolveAuthMode(env: Record<string, string | undefined> = process.env): AuthMode {
  const raw = env.AUTH_MODE?.trim().toLowerCase();
  const production = env.NODE_ENV === "production";
  if (raw === "clerk") return "clerk";
  if (raw === "dev") {
    if (production) {
      throw new AuthModeConfigError("AUTH_MODE=dev is refused when NODE_ENV=production. Use AUTH_MODE=clerk.");
    }
    return "dev";
  }
  if (raw) throw new AuthModeConfigError(`Unknown AUTH_MODE "${raw}". Use "clerk" or "dev".`);
  return production ? "clerk" : "dev";
}
