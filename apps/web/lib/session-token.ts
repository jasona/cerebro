import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed session token for the dev identity adapter (AUTH_MODE=dev only).
 * Format: base64url(JSON payload) "." base64url(HMAC-SHA256).
 */
export interface SessionPayload {
  sub: string; // users.auth_subject, e.g. "dev|riley"
  iat: number; // seconds since epoch
}

export const SESSION_COOKIE = "cerebro_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

const DEV_FALLBACK_SECRET = "cerebro-dev-only-secret-do-not-use-in-production";

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET (>= 32 chars) is required in production");
  }
  return DEV_FALLBACK_SECRET;
}

const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function encodeSession(payload: SessionPayload, secret = sessionSecret()): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

export function decodeSession(token: string | undefined, secret = sessionSecret(), now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;
  const expected = Buffer.from(sign(data, secret));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null;
    if (now / 1000 - payload.iat > SESSION_MAX_AGE_SECONDS) return null;
    return payload;
  } catch {
    return null;
  }
}
