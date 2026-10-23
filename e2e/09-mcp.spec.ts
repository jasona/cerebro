import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { build } from "esbuild";
import { BASE_URL, PLATFORM_TEAM, briefLink, contextAs, uid } from "./helpers";

const MCP_URL = `${BASE_URL}/api/mcp`;
const PREVIEW_UI_URI = "ui://cerebro/brief-preview-v1.html";
const MCP_APPS_CAPABILITIES = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

/** Bundle the AppBridge-based test host (e2e/support/mcp-app-host.ts) for the browser. */
async function hostBundle(): Promise<string> {
  const out = await build({
    entryPoints: [resolve(import.meta.dirname, "support/mcp-app-host.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}

/** Create a dev connection token from Settings → Connections (shown once). */
async function createToken(page: Page, label: string): Promise<string> {
  await page.goto("/c/acme/settings");
  const connections = page.getByRole("region", { name: "LLM connections" });
  await connections.getByRole("textbox", { name: "Connection name (required)" }).fill(label);
  await connections.getByRole("button", { name: "Create token" }).click();
  return connections.getByRole("textbox", { name: "Development connection token" }).inputValue();
}

interface ToolResult {
  isError?: boolean;
  text: string;
  sc: any;
}

async function connect(
  token: string,
  capabilities: ClientCapabilities = {},
): Promise<{ client: Client; call(name: string, args?: Record<string, unknown>): Promise<ToolResult> }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "cerebro-e2e-host", version: "1.0.0" }, { capabilities });
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

  test("an MCP Apps host shows the inline preview; its Publish control refuses a stale preview and publishes a fresh one (T14)", async ({ browser }) => {
    const author = await contextAs(browser, "maya");
    const alex = await contextAs(browser, "alex");
    const host = await browser.newPage();
    const title = `Inline preview roadmap ${uid()}`;
    let mcp: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const token = await createToken(author.page, `E2E apps host ${uid()}`);
      mcp = await connect(token, MCP_APPS_CAPABILITIES);
      const client = mcp.client;

      // The tool advertises the UI resource; the resource is the self-contained MCP App document.
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "preview_brief")?._meta).toMatchObject({ ui: { resourceUri: PREVIEW_UI_URI } });
      const resource = await client.readResource({ uri: PREVIEW_UI_URI });
      const content = resource.contents[0] as { mimeType: string; text: string };
      expect(content.mimeType).toBe("text/html;profile=mcp-app");

      const created = await mcp.call("create_brief_draft", {
        idempotency_key: `e2e-apps-${uid()}`,
        handoff: {
          handoffVersion: 1,
          title,
          kind: "strategy",
          position: { headline: "Consolidate onto one platform roadmap by Q2", summary: "Two parallel roadmaps are slowing delivery." },
          context: { stakes: "Duplicate work is delaying the Q2 launch." },
          request: { type: "decision", statement: "Approve a single platform roadmap." },
          evidence: [{ title: "Delivery review", excerpt: "Three integration projects were built twice.", attribution: "Q3 delivery review (fictional)" }],
          destination: { label: "Platform team" },
          audience: { visibility: "company" },
          origin: { host: "cerebro-e2e" },
        },
      });
      expect(created.isError, created.text).toBeFalsy();
      const briefingId = created.sc.briefing_id as string;
      const previewArgs = { briefing_id: briefingId };
      const preview = (await client.callTool({ name: "preview_brief", arguments: previewArgs })) as CallToolResult;
      const previewId = (preview.structuredContent as { preview_id: string }).preview_id;

      // Host page: blank, no network. Every browser request and CSP report is recorded.
      const requests: string[] = [];
      const cspErrors: string[] = [];
      host.on("request", (r) => requests.push(r.url()));
      host.on("console", (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
      });
      await host.emulateMedia({ colorScheme: "dark" });
      await host.exposeFunction("cerebroCallTool", (params: { name: string; arguments?: Record<string, unknown> }) =>
        client.callTool({ name: params.name, arguments: params.arguments ?? {} }),
      );
      await host.setContent('<!doctype html><html lang="en"><body><iframe title="Cerebro preview" sandbox="allow-scripts"></iframe></body></html>');
      await host.addScriptTag({ content: await hostBundle() });
      await host.evaluate((opts) => window.startHost(opts), { html: content.text, toolArguments: previewArgs, toolResult: preview });

      const view = host.frameLocator("iframe");
      await expect(view.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(view.getByText("Consolidate onto one platform roadmap by Q2")).toBeVisible();
      await expect(view.getByRole("heading", { name: "The decision" })).toBeVisible();
      await expect(view.getByText("Approve a single platform roadmap.")).toBeVisible();
      const facts = view.getByRole("definition");
      await expect(facts.filter({ hasText: "Acme / Product / Platform" })).toBeVisible();
      await expect(facts.filter({ hasText: "Everyone at Acme (company-wide)" })).toBeVisible();
      await expect(facts.filter({ hasText: "No supporting evidence attached; 1 candidate awaiting approval will not publish." })).toBeVisible();
      // Follows the OS colour scheme (dark here) with the design tokens.
      expect(await view.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(22, 21, 26)");

      // The draft changes after the preview was shown (evidence approved elsewhere).
      const candidate = (created.sc.evidence_candidates as { id: string }[])[0]!;
      const upd = await mcp.call("update_brief_draft", {
        briefing_id: briefingId,
        expected_version: created.sc.draft_version,
        evidence_decisions: [{ evidence_id: candidate.id, status: "approved" }],
        idempotency_key: `e2e-apps-upd-${uid()}`,
      });
      expect(upd.isError, upd.text).toBeFalsy();

      // Keyboard: Publish opens a confirmation (focus moves to it); Escape cancels and returns focus.
      const publish = view.getByRole("button", { name: "Publish", exact: true });
      await publish.focus();
      await host.keyboard.press("Enter");
      await expect(view.getByRole("heading", { name: "Publish this preview?" })).toBeFocused();
      await expect(view.getByRole("group", { name: "Publish this preview?" })).toContainText("Everyone at Acme (company-wide)");
      await host.keyboard.press("Escape");
      await expect(view.getByRole("group", { name: "Publish this preview?" })).toBeHidden();
      await expect(publish).toBeFocused();
      await host.keyboard.press("Enter");
      await host.keyboard.press("Tab");
      await expect(view.getByRole("button", { name: "Confirm and publish" })).toBeFocused();
      await host.keyboard.press("Enter");

      // The stale preview is refused server-side; the UI says so and offers a fresh preview.
      const alert = view.getByRole("alert");
      await expect(alert).toContainText("Not published: this preview is out of date.");
      await expect(alert).toContainText("Evidence approval changed.");
      await expect(publish).toBeDisabled();
      const calls = (await host.evaluate(() => window.hostEvents)).filter((e) => e.type === "tools/call");
      expect(calls).toHaveLength(1);
      // Only server-issued identifiers travel from the UI: no content, home or audience.
      const sent = calls[0]!.params as { name: string; arguments: Record<string, unknown> };
      expect(sent.name).toBe("publish_brief");
      expect(Object.keys(sent.arguments).sort()).toEqual(["briefing_id", "idempotency_key", "preview_id"]);
      expect(sent.arguments).toMatchObject({ briefing_id: briefingId, preview_id: previewId });
      expect((await mcp.call("get_brief", { briefing_id: briefingId, view: "draft" })).sc.current_revision_number).toBeNull();

      // Preview again, review, publish.
      await view.getByRole("button", { name: "Preview again" }).click();
      await expect(facts.filter({ hasText: "1 approved excerpt will publish." })).toBeVisible();
      await view.getByRole("button", { name: "Publish", exact: true }).click();
      await view.getByRole("button", { name: "Confirm and publish" }).click();
      await expect(view.getByRole("heading", { level: 1, name: title })).toBeFocused();
      await expect(view.getByText("Published. Revision 1 is now available to its audience.")).toBeVisible();
      const events = await host.evaluate(() => window.hostEvents);
      const published = events.filter((e) => e.type === "tools/call").at(-1)!.params as { arguments: Record<string, unknown> };
      expect(published.arguments.preview_id).not.toBe(previewId);
      // The model is told about a publish it did not perform.
      await expect
        .poll(async () => JSON.stringify((await host.evaluate(() => window.hostEvents)).filter((e) => e.type === "update-model-context").at(-1)))
        .toContain("revision 1");

      // A colleague discovers it; the view itself made no network requests and hit no CSP violations.
      await alex.page.goto(PLATFORM_TEAM);
      await expect(briefLink(alex.page.getByRole("list", { name: "Platform briefs" }), title)).toBeVisible();
      expect(requests.filter((u) => !u.startsWith("about:") && !u.startsWith("data:"))).toEqual([]);
      expect(cspErrors).toEqual([]);
    } finally {
      await mcp?.client.close().catch(() => undefined);
      await host.close();
      await author.context.close();
      await alex.context.close();
    }
  });
});
