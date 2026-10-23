/**
 * MCP Apps support (extension `io.modelcontextprotocol/ui`, spec 2026-01-26;
 * T14, W3.1): the inline preview UI resource and the tool metadata that
 * points to it. Hosts without the extension ignore the metadata and keep the
 * unchanged text summary plus the authenticated preview link.
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, getUiCapability, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { PREVIEW_UI_HTML } from "./preview-ui";

export { EXTENSION_ID as MCP_APPS_EXTENSION_ID, RESOURCE_MIME_TYPE as MCP_APP_MIME_TYPE };

/** Versioned so hosts that cache UI templates pick up a changed document. */
export const PREVIEW_UI_URI = "ui://cerebro/brief-preview-v1.html";

/**
 * Declared resource metadata: no external origins of any kind (the host then
 * applies the spec's restrictive default CSP), and a bordered card.
 */
export const PREVIEW_UI_META = {
  ui: {
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[], frameDomains: [] as string[], baseUriDomains: [] as string[] },
    prefersBorder: true,
  },
};

/** Tool `_meta` linking a tool's results to the preview UI. */
export const previewUiToolMeta = () => ({ ui: { resourceUri: PREVIEW_UI_URI } });

/** Server capability advertising the extension (SEP-1724 extension negotiation). */
export const MCP_APPS_SERVER_CAPABILITY = { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } };

/**
 * Whether the client declared MCP Apps support for HTML views.
 * `undefined` means the capabilities are not known on this connection.
 */
export function clientSupportsMcpApps(caps: ClientCapabilities | undefined): boolean | undefined {
  if (!caps) return undefined;
  return getUiCapability(caps)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

export function registerPreviewUi(server: McpServer): void {
  registerAppResource(
    server,
    "Cerebro brief preview",
    PREVIEW_UI_URI,
    {
      description: "Inline preview of exactly what a Cerebro brief would publish, with an explicit Publish control bound to the server-issued preview.",
      _meta: PREVIEW_UI_META,
    },
    async () => ({
      contents: [{ uri: PREVIEW_UI_URI, mimeType: RESOURCE_MIME_TYPE, text: PREVIEW_UI_HTML, _meta: PREVIEW_UI_META }],
    }),
  );
}

/**
 * Capability detection (spec "Server Behavior"). When the client's
 * capabilities are known on this connection and it did not declare the
 * extension, its tools are listed without UI metadata. The stateless HTTP
 * endpoint (T21) sees `initialize` and `tools/list` on separate requests, so
 * the capabilities are unknown there and the metadata stays: the spec has
 * hosts without the extension treat such tools as standard tools.
 */
export function gateUiMetadataOnCapabilities(server: McpServer, tools: RegisteredTool[]): void {
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    if (clientSupportsMcpApps(server.server.getClientCapabilities()) === false) {
      for (const tool of tools) {
        if (!tool._meta) continue;
        const { ui: _ui, "ui/resourceUri": _legacy, ...rest } = tool._meta;
        tool._meta = Object.keys(rest).length ? rest : undefined;
      }
    }
  };
}
