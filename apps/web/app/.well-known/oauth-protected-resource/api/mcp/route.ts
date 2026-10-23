/**
 * OAuth Protected Resource Metadata (RFC 9728) for `/api/mcp`, path-inserted
 * form. This is the URL advertised in `WWW-Authenticate: resource_metadata`.
 */
import { protectedResourceMetadataResponse } from "@cerebro/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return protectedResourceMetadataResponse({ appUrl: new URL(request.url).origin });
}
