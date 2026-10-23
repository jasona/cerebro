/**
 * Operational limits read from the environment (W4).
 *
 * No numerical limit has been agreed for the pilot (REMAINING_WORK.md W0,
 * RISKS_AND_DECISIONS.md P12). Every limit here is therefore OFF unless an
 * operator sets it, and nothing in the code base supplies a default value.
 *
 * A limit is written `<max>/<windowSeconds>`, for example `60/60` for "60 per
 * rolling minute". `off`, an empty value or an unset variable disables it. An
 * unparseable value also leaves the limit off, but is reported by the
 * readiness check (`/api/ready`) so misconfiguration is visible.
 */

export interface WindowLimit {
  max: number;
  windowSeconds: number;
}

export type Env = Record<string, string | undefined>;

/** Operations subject to per-user and per-connection rate limits. */
export const RATE_LIMIT_OPERATIONS = ["mcp_tool", "qa", "upload"] as const;
export type RateLimitOperation = (typeof RATE_LIMIT_OPERATIONS)[number];
export type RateLimitScope = "user" | "connection";

/** Environment variable for each operation and scope, e.g. `RATE_LIMIT_QA_PER_USER`. */
export const rateLimitEnvName = (op: RateLimitOperation, scope: RateLimitScope): string =>
  `RATE_LIMIT_${op.toUpperCase()}_PER_${scope.toUpperCase()}`;

/** Per-organization AI usage limits (rolling windows). */
export const AI_USAGE_ENV = { runs: "AI_USAGE_LIMIT_RUNS", tokens: "AI_USAGE_LIMIT_TOKENS" } as const;
export type AiUsageMeasure = keyof typeof AI_USAGE_ENV;

const LIMIT = /^\s*(\d{1,12})\s*\/\s*(\d{1,9})\s*$/;

/** Parse `<max>/<windowSeconds>`. Returns `null` for off, or `{ error }` when unparseable. */
export function parseWindowLimit(raw: string | undefined | null): WindowLimit | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "off" || v === "none" || v === "unlimited") return null;
  const m = LIMIT.exec(v);
  if (!m) return { error: "expected <max>/<windowSeconds> or off" };
  const max = Number(m[1]);
  const windowSeconds = Number(m[2]);
  if (!Number.isSafeInteger(max) || windowSeconds < 1) return { error: "window must be at least 1 second" };
  return { max, windowSeconds };
}

const isLimit = (v: ReturnType<typeof parseWindowLimit>): v is WindowLimit => !!v && !("error" in v);

/** The configured limit for one operation and scope, or null when off (or invalid). */
export function rateLimitFor(op: RateLimitOperation, scope: RateLimitScope, env: Env = process.env): WindowLimit | null {
  const parsed = parseWindowLimit(env[rateLimitEnvName(op, scope)]);
  return isLimit(parsed) ? parsed : null;
}

/** Process-wide default AI usage limit for every organization, or null when off. */
export function aiUsageLimitFor(measure: AiUsageMeasure, env: Env = process.env): WindowLimit | null {
  const parsed = parseWindowLimit(env[AI_USAGE_ENV[measure]]);
  return isLimit(parsed) ? parsed : null;
}

/** Names of limit variables that are set but unparseable (reported by readiness). */
export function invalidOpsConfig(env: Env = process.env): string[] {
  const names = [
    ...RATE_LIMIT_OPERATIONS.flatMap((op) => (["user", "connection"] as const).map((s) => rateLimitEnvName(op, s))),
    ...Object.values(AI_USAGE_ENV),
  ];
  const bad = names.filter((n) => {
    const p = parseWindowLimit(env[n]);
    return !!p && "error" in p;
  });
  const sweep = env.RETENTION_SWEEP_INTERVAL_SECONDS?.trim();
  if (sweep && sweep !== "off" && !/^\d{1,9}$/.test(sweep)) bad.push("RETENTION_SWEEP_INTERVAL_SECONDS");
  return bad;
}
