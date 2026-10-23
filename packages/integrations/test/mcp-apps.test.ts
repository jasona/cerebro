/**
 * MCP Apps inline preview (T14, W3.1): tool metadata, the UI resource, the
 * publish path the UI uses, capability detection and the unchanged text
 * fallback. The UI's own behavior in a browser is covered by e2e/09-mcp.spec.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWorld, type TestWorld } from "../../domain/src/testing";
import { createCerebroMcpServer, MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID, PREVIEW_UI_CSP, PREVIEW_UI_HTML, PREVIEW_UI_URI } from "../src/index";
import { ALL_SCOPES } from "../src/scopes";
import { APP_URL, connect, platformHandoff, type Connected } from "./helpers";

let w: TestWorld;
let mcp: Connected;

/** A seeded world and a connected stateless-HTTP client, per test (only where a server is needed). */
function useWorld() {
  beforeEach(async () => {
    w = await createTestWorld();
    mcp = await connect(w, "maya");
  });
  afterEach(async () => {
    // One round trip before closing: closing the PGlite world straight after the
    // initialize handshake, with no request in between, hangs the test worker.
    await mcp.client.ping().catch(() => undefined);
    await mcp.close().catch(() => undefined);
    await w.h.close();
  });
}

let keyN = 0;
const key = () => `apps-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

async function draftAndPreview() {
  const created = await mcp.call("create_brief_draft", { handoff: platformHandoff(), idempotency_key: key() });
  expect(created.isError, created.text).toBeFalsy();
  const briefingId = created.sc.briefing_id as string;
  const preview = await mcp.call("preview_brief", { briefing_id: briefingId });
  expect(preview.isError, preview.text).toBeFalsy();
  return { briefingId, preview };
}

/** An in-process, session-holding connection (capabilities known to the server). */
async function sessionClient(capabilities: Record<string, unknown>) {
  const server = createCerebroMcpServer({ db: w.h.db, ctx: w.ctx("maya", "acme", "mcp"), appUrl: APP_URL, scopes: ALL_SCOPES });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "apps-test-host", version: "1.0.0" }, { capabilities });
  await client.connect(clientSide);
  return { client, close: async () => (await client.close(), await server.close()) };
}

describe("tool metadata", () => {
  useWorld();

  it("links preview_brief and publish_brief to the preview UI resource; other tools have no UI", async () => {
    const { tools } = await mcp.client.listTools();
    for (const name of ["preview_brief", "publish_brief"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t._meta).toMatchObject({ ui: { resourceUri: PREVIEW_UI_URI } });
      // Default visibility: the model keeps the tool (text hosts) and the UI may call it.
      expect((t._meta as any).ui.visibility).toBeUndefined();
    }
    for (const t of tools.filter((x) => !["preview_brief", "publish_brief"].includes(x.name))) expect(t._meta?.ui).toBeUndefined();
  });

  it("advertises the extension in the server capabilities", async () => {
    expect(mcp.client.getServerCapabilities()?.extensions?.[MCP_APPS_EXTENSION_ID]).toEqual({ mimeTypes: [MCP_APP_MIME_TYPE] });
  });
});

describe("UI resource (served)", () => {
  useWorld();

  it("is listed and read as a self-contained HTML document with the MCP App mime type and a strict CSP", async () => {
    const { resources } = await mcp.client.listResources();
    const listed = resources.find((r) => r.uri === PREVIEW_UI_URI)!;
    expect(PREVIEW_UI_URI.startsWith("ui://")).toBe(true);
    expect(listed.mimeType).toBe("text/html;profile=mcp-app");
    expect(listed._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } });

    const read = await mcp.client.readResource({ uri: PREVIEW_UI_URI });
    expect(read.contents).toHaveLength(1);
    const content = read.contents[0] as { uri: string; mimeType: string; text: string; _meta?: any };
    expect(content.uri).toBe(PREVIEW_UI_URI);
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(content.text).toBe(PREVIEW_UI_HTML);
    expect(content.text.startsWith("<!doctype html>")).toBe(true);

    // The document carries its own CSP: nothing but its own hashed inline script and style.
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(content.text);
    expect(meta?.[1]).toBe(PREVIEW_UI_CSP);
    const directives = Object.fromEntries(PREVIEW_UI_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
    expect(directives).toMatchObject({
      "default-src": "'none'",
      "connect-src": "'none'",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'none'",
      "img-src": "data:",
    });
    expect(directives["script-src"]).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(directives["style-src"]).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(PREVIEW_UI_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // Exactly one inline script and one style, matching the hashes.
    expect(content.text.match(/<script/g)).toHaveLength(1);
    expect(content.text.match(/<style/g)).toHaveLength(1);
    const { createHash } = await import("node:crypto");
    const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
    expect(directives["script-src"]).toBe(sha(/<script>([\s\S]*)<\/script>/.exec(content.text)![1]!));
    expect(directives["style-src"]).toBe(sha(/<style>([\s\S]*)<\/style>/.exec(content.text)![1]!));
  });
});

describe("UI resource (document)", () => {
  it("contains no external URLs or loads", () => {
    expect(PREVIEW_UI_HTML).not.toMatch(/https?:\/\//i);
    expect(PREVIEW_UI_HTML).not.toMatch(/(?:src|href|action|srcset|poster|data)\s*=/i);
    expect(PREVIEW_UI_HTML).not.toMatch(/url\(|@import|<link|<iframe|<object|<embed|<img|<form/i);
    expect(PREVIEW_UI_HTML).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\b|import\(|\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("uses the same colour tokens as the design system, light and dark", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../../ui/src/tokens.css"), "utf8");
    const declared = (css: string) => new Map([...css.matchAll(/(--cb-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    const lightOf = (css: string) => declared(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
    const darkOf = (css: string) => declared(css.slice(css.indexOf(":root[data-theme=\"dark\"]")));
    const style = /<style>([\s\S]*)<\/style>/.exec(PREVIEW_UI_HTML)![1]!;
    for (const [pick, label] of [[lightOf, "light"], [darkOf, "dark"]] as const) {
      const ours = pick(style);
      const theirs = pick(tokens);
      expect(ours.size, label).toBeGreaterThan(10);
      for (const [name, value] of ours) expect(`${label} ${name}: ${value}`).toBe(`${label} ${name}: ${theirs.get(name)}`);
    }
    expect(style).toContain("@media (prefers-color-scheme: dark)");
  });
});

describe("preview result for the UI", () => {
  useWorld();

  it("adds the plain-language lead with the renderer's labels; the text fallback is unchanged", async () => {
    const { preview } = await draftAndPreview();
    expect(preview.sc).toMatchObject({
      status: "preview",
      kind: "strategy",
      kind_label: "Strategy briefing",
      position: { headline: "Consolidate onto one platform roadmap by Q2" },
      request: { type: "decision", label: "The decision", statement: "Approve a single platform roadmap.", due_date: null },
      audience_statement: "Everyone at Acme (company-wide)",
    });
    expect(preview.sc.position.summary).toContain("Two parallel roadmaps are slowing delivery.");
    // The text a host without UI shows is exactly the existing summary: no UI wording, no position block.
    const lines = preview.text.split("\n");
    expect(lines[0]).toMatch(/^Preview of "Consolidate the platform roadmap" \(draft version 1\)\. Not published\.$/);
    expect(lines).toContain("Home: Acme / Product / Platform");
    expect(lines).toContain("Audience: Everyone at Acme (company-wide)");
    expect(preview.text).not.toMatch(/Position|The decision|ui:\/\/|inline/i);
    expect(lines.at(-1)).toMatch(/explicitly asks to publish this preview/);
    expect(lines.at(-2)).toBe(`Review in Cerebro (sign-in required): ${preview.sc.preview_url}`);
  });
});

describe("publishing from the UI", () => {
  useWorld();

  // The UI's Publish control sends exactly these arguments through the host bridge.
  const uiPublishArgs = (sc: any, idempotency_key: string) => ({ briefing_id: sc.briefing_id, preview_id: sc.preview_id, idempotency_key });

  it("a stale preview is refused server-side and nothing is published", async () => {
    const { briefingId, preview } = await draftAndPreview();
    // The draft changes after the preview was shown.
    const draft = await mcp.call("get_brief", { briefing_id: briefingId, view: "draft" });
    const upd = await mcp.call("update_brief_draft", {
      briefing_id: briefingId,
      expected_version: draft.sc.draft_version,
      evidence_decisions: [{ evidence_id: draft.sc.evidence[0].id, status: "approved" }],
      idempotency_key: key(),
    });
    expect(upd.isError, upd.text).toBeFalsy();

    const stale = await mcp.call("publish_brief", uiPublishArgs(preview.sc, key()));
    expect(stale.isError).toBe(true);
    expect(stale.sc.error.code).toBe("stale_preview");
    expect(stale.sc.error.details.reasons).toContain("evidence");
    const meta = await mcp.call("get_brief", { briefing_id: briefingId, view: "draft" });
    expect(meta.sc.current_revision_number).toBeNull();

    // A fresh preview (the UI's "Preview again") publishes.
    const fresh = await mcp.call("preview_brief", { briefing_id: briefingId });
    const ok = await mcp.call("publish_brief", uiPublishArgs(fresh.sc, key()));
    expect(ok.isError, ok.text).toBeFalsy();
    expect(ok.sc).toMatchObject({ status: "published", revision_number: 1 });
  });

  it("content smuggled into the call has no effect: the preview binding decides what publishes", async () => {
    const { preview } = await draftAndPreview();
    const r = await mcp.call("publish_brief", {
      ...uiPublishArgs(preview.sc, key()),
      title: "Injected",
      document: { title: "Injected" },
      audience: { visibility: "restricted" },
    });
    expect(r.isError, r.text).toBeFalsy();
    const pub = await mcp.call("get_brief", { briefing_id: preview.sc.briefing_id });
    expect(pub.sc.title).toBe("Consolidate the platform roadmap");
    expect(pub.sc.document.title).toBe("Consolidate the platform roadmap");
    expect(pub.sc.audience.visibility).toBe("company");
  });
});

describe("capability detection", () => {
  useWorld();

  const ui = { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };

  it("a session client that declared the extension sees the UI metadata", async () => {
    const s = await sessionClient(ui);
    try {
      const { tools } = await s.client.listTools();
      expect(tools.find((t) => t.name === "preview_brief")!._meta).toMatchObject({ ui: { resourceUri: PREVIEW_UI_URI } });
    } finally {
      await s.close();
    }
  });

  it("a session client without the extension gets plain tools and the same text results", async () => {
    const s = await sessionClient({});
    try {
      const { tools } = await s.client.listTools();
      for (const name of ["preview_brief", "publish_brief"]) {
        const t = tools.find((x) => x.name === name)!;
        expect(t._meta?.ui).toBeUndefined();
        expect(t._meta?.["ui/resourceUri"]).toBeUndefined();
      }
      const { briefingId, preview } = await draftAndPreview();
      const again = (await s.client.callTool({ name: "preview_brief", arguments: { briefing_id: briefingId } })) as any;
      const text = again.content.map((c: any) => c.text).join("\n");
      // Same summary as any other client, apart from the new preview id and expiry.
      const normalise = (t: string) => t.replace(/Preview id: .*$/m, "Preview id: <id>");
      expect(normalise(text)).toBe(normalise(preview.text));
    } finally {
      await s.close();
    }
  });

  it("a client declaring the extension without HTML support is treated as unsupported", async () => {
    const s = await sessionClient({ extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/uri-list"] } } });
    try {
      const { tools } = await s.client.listTools();
      expect(tools.find((t) => t.name === "preview_brief")!._meta?.ui).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
