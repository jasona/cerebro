/**
 * MCP request authentication.
 *
 * D08 DEV/TEST STAND-IN: this accepts Cerebro connection tokens
 * (`Authorization: Bearer cbr_…`) created by the user in Settings →
 * Connections. They are not the production delegated-authorization design.
 * Production uses an MCP-compatible OAuth authorization server (Clerk's
 * OAuth/MCP support is the first candidate, pending verification), with an
 * OAuth protected-resource metadata endpoint added later. Until then,
 * connection tokens are refused when NODE_ENV=production unless
 * CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1 is set explicitly.
 *
 * Tokens are read only from the Authorization header, never from tool
 * arguments, and are never logged.
 */
import type { Database } from "@cerebro/database";
import { authenticateConnectionToken, isDomainError, type RequestContext } from "@cerebro/domain";

export const WWW_AUTHENTICATE = 'Bearer realm="cerebro"';

export type McpAuthResult = { ok: true; ctx: RequestContext } | { ok: false; response: Response };

export interface McpAuthOptions {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** True when connection tokens may be accepted in this environment. */
export function devConnectionTokensAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || env.CEREBRO_ALLOW_DEV_CONNECTION_TOKENS === "1";
}

export function unauthorizedResponse(message: string, error: "invalid_token" | "invalid_request" = "invalid_token"): Response {
  return new Response(JSON.stringify({ error: { code: "unauthenticated", message } }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `${WWW_AUTHENTICATE}, error="${error}", error_description="${message.replace(/"/g, "'")}"`,
    },
  });
}

/** Resolve the request's bearer connection token to a RequestContext, or a 401 response. */
export async function authenticateMcpRequest(db: Database, request: Request, opts: McpAuthOptions = {}): Promise<McpAuthResult> {
  if (!devConnectionTokensAllowed(opts.env ?? process.env)) {
    return {
      ok: false,
      response: unauthorizedResponse(
        "Connection tokens are a development stand-in and are disabled in production. OAuth account linking is not yet available.",
      ),
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) {
    return { ok: false, response: unauthorizedResponse("Missing bearer connection token.", "invalid_request") };
  }
  try {
    return { ok: true, ctx: await authenticateConnectionToken(db, match[1]!) };
  } catch (e) {
    if (isDomainError(e) && e.code === "unauthenticated") {
      return { ok: false, response: unauthorizedResponse("Invalid, expired or revoked connection token. Reconnect Cerebro.") };
    }
    throw e;
  }
}
