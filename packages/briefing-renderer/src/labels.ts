import type { BriefingDocument } from "@cerebro/briefing-schema/client";

/*
 * Reader-facing labels shared by every briefing surface: the React renderer
 * and the MCP Apps inline preview (`@cerebro/integrations`), so a brief's kind
 * and request read the same everywhere. Plain data, no React.
 */

export const KIND_LABEL: Record<BriefingDocument["kind"], string> = {
  strategy: "Strategy briefing",
  decision: "Decision briefing",
  plan: "Plan",
  update: "Update",
};

export const REQUEST_LABEL: Record<BriefingDocument["request"]["type"], string> = {
  decision: "The decision",
  approval: "Approval requested",
  input: "Input requested",
  awareness: "For your awareness",
};
