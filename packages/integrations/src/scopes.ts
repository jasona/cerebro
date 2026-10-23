/**
 * OAuth scopes for the MCP tools (W2.2). Scopes bound what a connected host
 * may attempt; they never replace resource permissions, which the domain
 * services check on every call (LLM_INTEGRATION.md, "Account linking").
 *
 * - `cerebro:read`    authoring context, finding and reading briefs, operation
 *                     status, submitted author feedback
 * - `cerebro:draft`   create and update private drafts, create previews
 * - `cerebro:publish` publish a reviewed preview
 *
 * Scopes are independent: `cerebro:publish` does not imply drafting, and
 * drafting does not imply publishing.
 */
export const MCP_SCOPES = ["cerebro:read", "cerebro:draft", "cerebro:publish"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** The scope each tool requires. Every registered tool must appear here (tested). */
export const TOOL_SCOPES = {
  get_authoring_context: "cerebro:read",
  get_operation: "cerebro:read",
  find_briefs: "cerebro:read",
  get_brief: "cerebro:read",
  get_author_feedback: "cerebro:read",
  create_brief_draft: "cerebro:draft",
  update_brief_draft: "cerebro:draft",
  preview_brief: "cerebro:draft",
  publish_brief: "cerebro:publish",
} as const satisfies Record<string, McpScope>;
export type McpToolName = keyof typeof TOOL_SCOPES;

export const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s);

/** The scope a tool requires, or undefined for an unknown tool (the SDK then answers "tool not found"). */
export const requiredScope = (tool: unknown): McpScope | undefined =>
  typeof tool === "string" && Object.hasOwn(TOOL_SCOPES, tool) ? TOOL_SCOPES[tool as McpToolName] : undefined;

/** Dev connection tokens are full-access for the user's own permissions (D08 dev/test stand-in). */
export const ALL_SCOPES: ReadonlySet<McpScope> = new Set(MCP_SCOPES);
