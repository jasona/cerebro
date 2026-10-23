/**
 * Streamable HTTP handling for `/api/mcp` (T21), stateless: every request is
 * authenticated, and gets a fresh McpServer + transport bound to that
 * request's context. No server-side session state, so revocation takes
 * effect on the next request.
 */
import type { Database } from "@cerebro/database";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest, type McpAuthOptions } from "./auth";
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

/** Handle one MCP HTTP request (POST; GET/DELETE answer 405 in stateless mode). */
export async function handleMcpHttpRequest(request: Request, opts: McpHttpOptions): Promise<Response> {
  const auth = await authenticateMcpRequest(opts.db, request, opts);
  if (!auth.ok) return auth.response;
  // Stateless mode: no standalone SSE stream (GET) and no session to delete.
  if (request.method !== "POST") return methodNotAllowed();

  const server = createCerebroMcpServer({ db: opts.db, ctx: auth.ctx, appUrl: opts.appUrl });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete once returned; release the per-request server.
    await server.close().catch(() => undefined);
  }
}
