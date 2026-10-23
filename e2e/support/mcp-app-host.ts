/**
 * A minimal MCP Apps host for e2e/09-mcp.spec.ts, built on the official
 * host-side bridge (`AppBridge` from @modelcontextprotocol/ext-apps). The
 * spec bundles this file with esbuild and injects it into a blank page. It
 * renders a `ui://` HTML resource in a sandboxed iframe (scripts only, opaque
 * origin), forwards the view's `tools/call` requests to the test's real MCP
 * client through `window.cerebroCallTool`, and records what the view asks of
 * the host.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type HostEvent = { type: "tools/call" | "update-model-context" | "open-link"; params: unknown };

declare global {
  interface Window {
    cerebroCallTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
    hostEvents: HostEvent[];
    startHost(opts: { html: string; toolArguments: Record<string, unknown>; toolResult: CallToolResult; theme?: "light" | "dark" }): Promise<void>;
  }
}

window.hostEvents = [];

window.startHost = async ({ html, toolArguments, toolResult, theme }) => {
  const iframe = document.querySelector("iframe");
  if (!iframe?.contentWindow) throw new Error("no iframe");
  const bridge = new AppBridge(
    null,
    { name: "cerebro-e2e-host", version: "1.0.0" },
    { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
    { hostContext: { displayMode: "inline", ...(theme ? { theme } : {}) } },
  );
  bridge.oncalltool = async (params) => {
    window.hostEvents.push({ type: "tools/call", params });
    return window.cerebroCallTool(params);
  };
  bridge.onupdatemodelcontext = async (params) => {
    window.hostEvents.push({ type: "update-model-context", params });
    return {};
  };
  bridge.onopenlink = async (params) => {
    window.hostEvents.push({ type: "open-link", params });
    return {};
  };
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  // Listen before the view loads: it sends ui/initialize as soon as its script runs.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.srcdoc = html;
  await initialized;
  await bridge.sendToolInput({ arguments: toolArguments });
  await bridge.sendToolResult(toolResult);
};
