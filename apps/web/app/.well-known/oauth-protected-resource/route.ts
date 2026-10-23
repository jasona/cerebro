/**
 * OAuth Protected Resource Metadata (RFC 9728) for the MCP endpoint, root
 * form. 404 until CEREBRO_OAUTH_ISSUER names an authorization server.
 */
import { protectedResourceMetadataResponse } from "@cerebro/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return protectedResourceMetadataResponse({ appUrl: new URL(request.url).origin });
}
