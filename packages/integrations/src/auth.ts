/**
 * MCP request authentication (D08). Two bearer credentials are accepted:
 *
 * - OAuth access tokens (production path, W2.2): JWTs from the authorization
 *   server named by `CEREBRO_OAUTH_ISSUER`, verified in `./oauth`, mapped to a
 *   user and a revocable connection by the domain (`authenticateOAuthGrant`).
 *   Scopes limit which tools may run (`./scopes`).
 * - Connection tokens (`cbr_…`, D08 DEV/TEST STAND-IN): created in Settings →
 *   Connections. Refused when NODE_ENV=production unless
 *   CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1 is set explicitly. They carry every
 *   MCP scope; the user's own permissions still apply.
 *
 * Tokens are read only from the Authorization header, never from tool
 * arguments, and are never logged.
 */
import type { Database } from "@cerebro/database";
import { authenticateConnectionToken, authenticateOAuthGrant, CONNECTION_TOKEN_PREFIX, isDomainError, type RequestContext } from "@cerebro/domain";
import { oauthConfig, verifyAccessToken, type OAuthResourceConfig, type VerifyOptions } from "./oauth";
import { ALL_SCOPES, MCP_SCOPES, type McpScope } from "./scopes";

export const WWW_AUTHENTICATE = 'Bearer realm="cerebro"';

export type McpAuthResult =
  | { ok: true; ctx: RequestContext; scopes: ReadonlySet<McpScope>; oauth: OAuthResourceConfig | null }
  | { ok: false; response: Response };

export interface McpAuthOptions {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** App base URL; the OAuth resource URL falls back to it outside production when APP_URL is unset. */
  appUrl?: string;
  /** Test seams for access-token verification (local JWKS, fetch). */
  oauth?: VerifyOptions;
}

/** True when connection tokens may be accepted in this environment. */
export function devConnectionTokensAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || env.CEREBRO_ALLOW_DEV_CONNECTION_TOKENS === "1";
}

const quote = (s: string) => s.replace(/["\\]/g, "'");

/** `WWW-Authenticate` value: realm, optional error, and (when OAuth is on) resource metadata and scopes. */
export function bearerChallenge(opts: {
  error?: "invalid_token" | "invalid_request" | "insufficient_scope";
  description?: string;
  oauth?: OAuthResourceConfig | null;
  scope?: readonly string[];
}): string {
  const parts = [WWW_AUTHENTICATE];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.description) parts.push(`error_description="${quote(opts.description)}"`);
  if (opts.oauth) {
    parts.push(`resource_metadata="${opts.oauth.resourceMetadataUrl}"`);
    parts.push(`scope="${(opts.scope ?? MCP_SCOPES).join(" ")}"`);
  }
  return parts.join(", ");
}

export function unauthorizedResponse(
  message: string,
  error: "invalid_token" | "invalid_request" | null = "invalid_token",
  oauth: OAuthResourceConfig | null = null,
): Response {
  return new Response(JSON.stringify({ error: { code: "unauthenticated", message } }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": bearerChallenge({ ...(error ? { error } : {}), description: message, oauth }),
    },
  });
}

export function forbiddenResponse(
  message: string,
  opts: { reason?: string; oauth?: OAuthResourceConfig | null; insufficientScope?: readonly string[] } = {},
): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.insufficientScope) {
    headers["www-authenticate"] = bearerChallenge({
      error: "insufficient_scope",
      description: message,
      oauth: opts.oauth ?? null,
      scope: opts.insufficientScope,
    });
  }
  return new Response(
    JSON.stringify({ error: { code: "forbidden", message, ...(opts.reason ? { details: { reason: opts.reason } } : {}) } }),
    { status: 403, headers },
  );
}

/** Resolve the request's bearer credential to a RequestContext and scopes, or an error response. */
export async function authenticateMcpRequest(db: Database, request: Request, opts: McpAuthOptions = {}): Promise<McpAuthResult> {
  const env = opts.env ?? process.env;
  const oauth = oauthConfig(env);
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1];

  if (!token) {
    if (!oauth && !devConnectionTokensAllowed(env)) return { ok: false, response: devTokensDisabled() };
    // No error code when no credentials were sent (RFC 6750 §3.1); clients
    // discover the authorization server from resource_metadata.
    return {
      ok: false,
      response: unauthorizedResponse(oauth ? "Authorization required." : "Missing bearer connection token.", oauth ? null : "invalid_request", oauth),
    };
  }

  if (token.startsWith(CONNECTION_TOKEN_PREFIX)) {
    if (!devConnectionTokensAllowed(env)) return { ok: false, response: devTokensDisabled(oauth) };
    try {
      return { ok: true, ctx: await authenticateConnectionToken(db, token), scopes: ALL_SCOPES, oauth };
    } catch (e) {
      if (isDomainError(e) && e.code === "unauthenticated") {
        return { ok: false, response: unauthorizedResponse("Invalid, expired or revoked connection token. Reconnect Cerebro.", "invalid_token", oauth) };
      }
      throw e;
    }
  }

  if (!oauth) {
    return {
      ok: false,
      response: devConnectionTokensAllowed(env)
        ? unauthorizedResponse("Invalid connection token. OAuth is not configured for this deployment.")
        : devTokensDisabled(),
    };
  }

  const verified = await verifyAccessToken(token, oauth, opts.oauth);
  if (!verified.ok) {
    const message = verified.reason === "expired" ? "The access token has expired." : "Invalid access token.";
    return { ok: false, response: unauthorizedResponse(message, "invalid_token", oauth) };
  }
  const t = verified.token;
  try {
    const ctx = await authenticateOAuthGrant(db, {
      issuer: t.issuer,
      subject: t.subject,
      clientId: t.clientId,
      scopes: [...t.scopes],
      authTime: t.authTime,
    });
    return { ok: true, ctx, scopes: t.scopes, oauth };
  } catch (e) {
    if (isDomainError(e) && e.code === "unauthenticated") {
      return { ok: false, response: unauthorizedResponse(`${e.message} Reconnect Cerebro.`, "invalid_token", oauth) };
    }
    if (isDomainError(e) && (e.code === "forbidden" || e.code === "validation")) {
      const reason = typeof e.details?.reason === "string" ? e.details.reason : undefined;
      return { ok: false, response: forbiddenResponse(e.message, { ...(reason ? { reason } : {}), oauth }) };
    }
    throw e;
  }
}

function devTokensDisabled(oauth: OAuthResourceConfig | null = null): Response {
  return unauthorizedResponse(
    oauth
      ? "Connection tokens are a development stand-in and are disabled in production. Connect Cerebro with OAuth."
      : "Connection tokens are a development stand-in and are disabled in production. OAuth account linking is not configured.",
    "invalid_token",
    oauth,
  );
}
