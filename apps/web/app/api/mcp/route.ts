/**
 * MCP Streamable HTTP endpoint (T21) for connected LLM hosts. Stateless: each
 * request is authenticated with a bearer connection token (D08 dev/test
 * stand-in; production will use OAuth) and served by a fresh MCP server.
 */
import { getDatabase } from "@cerebro/database";
import { handleMcpHttpRequest } from "@cerebro/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appUrl = (request: Request) => (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/+$/, "");

async function handle(request: Request): Promise<Response> {
  const { db } = await getDatabase();
  return handleMcpHttpRequest(request, { db, appUrl: appUrl(request) });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
