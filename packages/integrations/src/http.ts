/**
 * Streamable HTTP handling for `/api/mcp` (T21), stateless: every request is
 * authenticated, and gets a fresh McpServer + transport bound to that
 * request's context and scopes. No server-side session state, so revocation
 * takes effect on the next request.
 */
import type { Database } from "@cerebro/database";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest, forbiddenResponse, type McpAuthOptions } from "./auth";
import { requiredScope, type McpScope } from "./scopes";
import { createCerebroMcpServer } from "./server";

export interface McpHttpOptions extends McpAuthOptions {
  db: Database;
  appUrl: string;
}

const methodNotAllowed = () =>
  new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "This stateless MCP endpoint accepts POST only." } }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });

/**
 * Scopes missing for the `tools/call` messages in a JSON-RPC body (single or
 * batch). Unparseable bodies yield none here; the transport rejects them.
 */
async function missingToolScopes(request: Request, granted: ReadonlySet<McpScope>): Promise<McpScope[]> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const messages = Array.isArray(body) ? body : [body];
  const missing = new Set<McpScope>();
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "tools/call") continue;
    const scope = requiredScope((m as { params?: { name?: unknown } }).params?.name);
    if (scope && !granted.has(scope)) missing.add(scope);
  }
  return [...missing];
}

/** Handle one MCP HTTP request (POST; GET/DELETE answer 405 in stateless mode). */
export async function handleMcpHttpRequest(request: Request, opts: McpHttpOptions): Promise<Response> {
  const auth = await authenticateMcpRequest(opts.db, request, opts);
  if (!auth.ok) return auth.response;
  // Stateless mode: no standalone SSE stream (GET) and no session to delete.
  if (request.method !== "POST") return methodNotAllowed();

  // Insufficient scope is answered at the HTTP layer (403 + insufficient_scope
  // challenge) so hosts can ask the user for a step-up authorization. The
  // server re-checks per tool as well.
  const missing = await missingToolScopes(request, auth.scopes);
  if (missing.length > 0) {
    return forbiddenResponse(`This connection is not authorized for ${missing.join(", ")}.`, {
      reason: "insufficient_scope",
      oauth: auth.oauth,
      insufficientScope: [...new Set([...auth.scopes, ...missing])],
    });
  }

  const server = createCerebroMcpServer({ db: opts.db, ctx: auth.ctx, appUrl: opts.appUrl, scopes: auth.scopes });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete once returned; release the per-request server.
    await server.close().catch(() => undefined);
  }
}
