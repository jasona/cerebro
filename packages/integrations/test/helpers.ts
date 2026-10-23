import { createConnectionToken } from "@cerebro/domain";
import type { TestWorld } from "../../domain/src/testing";
import type { SeedUserKey } from "@cerebro/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest } from "../src/index";

export const APP_URL = "http://localhost:3000";
export const MCP_URL = `${APP_URL}/api/mcp`;

export interface ToolResult {
  isError?: boolean;
  text: string;
  sc: any;
}

export interface Connected {
  client: Client;
  token: string;
  connectionId: string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Real MCP client over Streamable HTTP, served in-process by the /api/mcp handler. */
export async function connect(w: TestWorld, user: SeedUserKey = "maya", org: "acme" | "globex" = "acme"): Promise<Connected> {
  const { token, connection } = await createConnectionToken(w.h.db, w.ctx(user, org), { label: "Test host" });
  const client = await connectWithToken(w, token);
  return {
    client,
    token,
    connectionId: connection.id,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
        structuredContent?: unknown;
      };
      return { isError: r.isError, text: r.content.map((c) => c.text ?? "").join("\n"), sc: r.structuredContent };
    },
    close: () => client.close(),
  };
}

export async function connectWithToken(w: TestWorld, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => handleMcpHttpRequest(new Request(url, init), { db: w.h.db, appUrl: APP_URL }),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "cerebro-test-host", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** A handoff as a host would send it: selected content only, evidence as candidates. */
export function platformHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handoffVersion: 1,
    title: "Consolidate the platform roadmap",
    kind: "strategy",
    position: {
      headline: "Consolidate onto one platform roadmap by Q2",
      summary: "Two parallel roadmaps are slowing delivery. We should merge them into one plan owned by the Platform team.",
    },
    context: { stakes: "Duplicate work is delaying the Q2 launch." },
    request: { type: "decision", statement: "Approve a single platform roadmap." },
    rationale: "One roadmap removes duplicated integration work and clarifies ownership.",
    alternatives: [
      { label: "Merge roadmaps", chosen: true },
      { label: "Keep both roadmaps" },
    ],
    risks: [{ statement: "Short-term reprioritisation cost", mitigation: "Phase the merge over two sprints." }],
    actions: [{ statement: "Draft the merged roadmap" }],
    perspectives: [{ label: "Finance", summary: "Lower duplicated spend.", implications: ["Fewer parallel vendor contracts."] }],
    evidence: [
      {
        title: "Delivery review",
        excerpt: "Three integration projects were built twice in the last two quarters.",
        attribution: "Q3 delivery review",
        supports: ["recommendation"],
      },
      { title: "Hallway note", excerpt: "Someone said the teams overlap.", attribution: "Unverified conversation" },
    ],
    destination: { label: "Platform team" },
    origin: { host: "test-host" },
    ...overrides,
  };
}
