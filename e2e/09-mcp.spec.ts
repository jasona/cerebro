import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BASE_URL, PLATFORM_TEAM, briefLink, contextAs, uid } from "./helpers";

const MCP_URL = `${BASE_URL}/api/mcp`;

interface ToolResult {
  isError?: boolean;
  text: string;
  sc: any;
}

async function connect(token: string): Promise<{ client: Client; call(name: string, args?: Record<string, unknown>): Promise<ToolResult> }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "cerebro-e2e-host", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
        structuredContent?: unknown;
      };
      return { isError: r.isError, text: r.content.map((c) => c.text ?? "").join("\n"), sc: r.structuredContent };
    },
  };
}

test.describe("MCP over HTTP (live server)", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("Maya connects, drafts, previews and publishes from a connected LLM; a revoked token is unauthenticated", async ({ browser }) => {
    // Maya (a Platform member) is the author. Riley, an owner outside Platform, is refused the
    // "Platform team" destination over MCP although the web studio lets owners home a brief
    // anywhere (D10); see the e2e report.
    const author = await contextAs(browser, "maya");
    const alex = await contextAs(browser, "alex");
    const label = `E2E host ${uid()}`;
    const title = `Consolidate the platform roadmap ${uid()}`;
    let mcp: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      // The author creates a connection token; it is shown once.
      await author.page.goto("/c/acme/settings");
      const connections = author.page.getByRole("region", { name: "LLM connections" });
      await connections.getByRole("textbox", { name: "Connection name (required)" }).fill(label);
      await connections.getByRole("button", { name: "Create token" }).click();
      const secret = connections.getByRole("textbox", { name: "Development connection token" });
      await expect(secret).toBeVisible();
      const token = await secret.inputValue();
      expect(token).toMatch(/^cbr_/);

      // Unauthenticated requests are refused outright.
      const anon = await fetch(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(anon.status).toBe(401);

      mcp = await connect(token);
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_authoring_context", "create_brief_draft", "preview_brief", "publish_brief"]));

      const ctx = await mcp.call("get_authoring_context");
      expect(ctx.isError, ctx.text).toBeFalsy();
      expect(ctx.sc.company.name).toBe("Acme");

      const created = await mcp.call("create_brief_draft", {
        idempotency_key: `e2e-create-${uid()}`,
        handoff: {
          handoffVersion: 1,
          title,
          kind: "strategy",
          position: {
            headline: "Consolidate onto one platform roadmap by Q2",
            summary: "Two parallel roadmaps are slowing delivery. We should merge them into one plan owned by the Platform team.",
          },
          context: { stakes: "Duplicate work is delaying the Q2 launch." },
          request: { type: "decision", statement: "Approve a single platform roadmap." },
          rationale: "One roadmap removes duplicated integration work and clarifies ownership.",
          alternatives: [{ label: "Merge roadmaps", chosen: true }, { label: "Keep both roadmaps" }],
          evidence: [
            {
              title: "Delivery review",
              excerpt: "Three integration projects were built twice in the last two quarters.",
              attribution: "Q3 delivery review (fictional)",
              supports: ["recommendation"],
            },
          ],
          destination: { label: "Platform team" },
          audience: { visibility: "company" },
          origin: { host: "cerebro-e2e" },
        },
      });
      expect(created.isError, created.text).toBeFalsy();
      expect(created.sc.status, created.text).toBe("draft");
      expect(created.sc.home.label).toBe("Acme / Product / Platform");
      const briefingId = created.sc.briefing_id as string;
      const slug = created.sc.slug as string;

      // Drafts are private.
      await alex.page.goto(PLATFORM_TEAM);
      await expect(briefLink(alex.page, title)).toHaveCount(0);

      const preview = await mcp.call("preview_brief", { briefing_id: briefingId });
      expect(preview.isError, preview.text).toBeFalsy();
      expect(preview.text).toContain("Audience: Everyone at Acme (company-wide)");
      expect(preview.text).toContain("Home: Acme / Product / Platform");
      const previewLink = `${BASE_URL}/c/acme/b/${slug}/preview`;
      expect(preview.text).toContain(previewLink);
      expect(preview.sc.preview_url).toBe(previewLink);

      // The preview link opens the authenticated review page for the author.
      await author.page.goto(previewLink);
      await expect(author.page.getByRole("heading", { level: 1, name: "Preview and publish" })).toBeVisible();

      const published = await mcp.call("publish_brief", {
        briefing_id: briefingId,
        preview_id: preview.sc.preview_id,
        idempotency_key: `e2e-publish-${uid()}`,
      });
      expect(published.isError, published.text).toBeFalsy();
      expect(published.sc.status).toBe("published");

      // A colleague discovers it in the team view.
      await alex.page.goto(PLATFORM_TEAM);
      const list = alex.page.getByRole("list", { name: "Platform briefs" });
      await expect(briefLink(list, title)).toBeVisible();

      // Revoking the connection makes the very next request unauthenticated.
      await author.page.goto("/c/acme/settings");
      const revoke = author.page.getByRole("button", { name: `Revoke connection ${label}` });
      await revoke.click();
      await expect(revoke).toHaveCount(0);
      await expect(mcp.call("get_authoring_context")).rejects.toThrow(/401|unauth/i);
    } finally {
      await mcp?.client.close().catch(() => undefined);
      await author.context.close();
      await alex.context.close();
    }
  });
  test("an owner can target any team over MCP, as in the studio (D10)", async ({ browser }) => {
    const riley = await contextAs(browser, "riley");
    let mcp: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await riley.page.goto("/c/acme/settings");
      const connections = riley.page.getByRole("region", { name: "LLM connections" });
      const label = `E2E owner host ${uid()}`;
      await connections.getByRole("textbox", { name: "Connection name (required)" }).fill(label);
      await connections.getByRole("button", { name: "Create token" }).click();
      const token = await connections.getByRole("textbox", { name: "Development connection token" }).inputValue();
      mcp = await connect(token);
      const created = await mcp.call("create_brief_draft", {
        idempotency_key: `e2e-owner-${uid()}`,
        handoff: {
          handoffVersion: 1,
          title: `Owner-authored platform note ${uid()}`,
          kind: "update",
          position: { headline: "Platform priorities for next quarter", summary: "A short update on platform priorities." },
          context: { stakes: "Teams need to plan around platform changes." },
          request: { type: "awareness", statement: "Read before quarterly planning." },
          destination: { label: "Platform team" },
          origin: { host: "cerebro-e2e" },
        },
      });
      expect(created.isError, created.text).toBeFalsy();
      expect(created.sc.home.label).toBe("Acme / Product / Platform");
      await riley.page.goto("/c/acme/settings");
      await riley.page.getByRole("button", { name: `Revoke connection ${label}` }).click();
    } finally {
      await mcp?.client.close().catch(() => undefined);
      await riley.context.close();
    }
  });
});
