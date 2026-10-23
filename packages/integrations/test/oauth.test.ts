/**
 * MCP as an OAuth 2.1 protected resource (W2.2). A local JWKS stands in for
 * the authorization server, which is deliberately not chosen here; Cerebro
 * only verifies tokens and maps them to users and revocable grants.
 */
import { listConnections, revokeConnection } from "@cerebro/domain";
import { integrationConnections, memberships, userIdentities, withSystemContext } from "@cerebro/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorld, type TestWorld } from "../../domain/src/testing";
import {
  createCerebroMcpServer,
  handleMcpHttpRequest,
  MCP_SCOPES,
  oauthConfig,
  protectedResourceMetadataResponse,
  TOOL_SCOPES,
  type McpScope,
} from "../src/index";
import { APP_URL, MCP_URL, platformHandoff } from "./helpers";

const ISSUER = "https://auth.example.test";
const METADATA_URL = `${APP_URL}/.well-known/oauth-protected-resource/api/mcp`;
const ENV = { NODE_ENV: "test", CEREBRO_OAUTH_ISSUER: ISSUER, APP_URL };
const PROD_ENV = { ...ENV, NODE_ENV: "production" };
const ALL = MCP_SCOPES.join(" ");

let signingKey: CryptoKey;
let strangerKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  strangerKey = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  getKey = createLocalJWKSet({ keys: [jwk] });
});

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
  await withSystemContext(w.h.db, (tx) =>
    tx.insert(userIdentities).values([
      { userId: w.seed.users.maya, issuer: ISSUER, subject: "sub-maya" },
      { userId: w.seed.users.alex, issuer: ISSUER, subject: "sub-alex" },
    ]),
  );
});
afterEach(async () => {
  await w.h.close();
});

const nowSec = () => Math.floor(Date.now() / 1000);

interface TokenOpts {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  scope?: string;
  clientId?: string | null;
  authTime?: number;
  key?: CryptoKey;
}

function token(o: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = { scope: o.scope ?? ALL, auth_time: o.authTime ?? nowSec() - 30 };
  if (o.clientId !== null) claims.client_id = o.clientId ?? "host-a";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? MCP_URL)
    .setSubject(o.sub ?? "sub-maya")
    .setIssuedAt()
    .setExpirationTime(o.exp ?? nowSec() + 300)
    .sign(o.key ?? signingKey);
}

const send = (req: Request, env: Record<string, string | undefined> = ENV) =>
  handleMcpHttpRequest(req, { db: w.h.db, appUrl: APP_URL, env, oauth: { getKey } });

function rpc(body: unknown, bearer?: string): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const listTools = (bearer?: string, env?: Record<string, string | undefined>) =>
  send(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer), env);

async function connectClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => send(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "oauth-test-host", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const oauthConnections = () =>
  withSystemContext(w.h.db, (tx) => tx.select().from(integrationConnections).where(eq(integrationConnections.kind, "oauth")));

describe("protected resource metadata (RFC 9728)", () => {
  it("advertises the configured issuer, resource and scopes, and is absent while OAuth is unconfigured", async () => {
    const res = protectedResourceMetadataResponse({ env: ENV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: MCP_URL,
      authorization_servers: [ISSUER],
      scopes_supported: ["cerebro:read", "cerebro:draft", "cerebro:publish"],
      bearer_methods_supported: ["header"],
      resource_name: "Cerebro",
    });
    expect(protectedResourceMetadataResponse({ env: { NODE_ENV: "test", APP_URL } }).status).toBe(404);
  });

  it("derives the resource from APP_URL; production never falls back to the request origin", () => {
    expect(oauthConfig({ CEREBRO_OAUTH_ISSUER: ISSUER, NODE_ENV: "test" }, "http://localhost:3999")?.resource).toBe("http://localhost:3999/api/mcp");
    expect(oauthConfig({ CEREBRO_OAUTH_ISSUER: ISSUER, NODE_ENV: "production" }, "https://evil.example")).toBeNull();
    expect(oauthConfig({ CEREBRO_OAUTH_ISSUER: ISSUER, NODE_ENV: "production", APP_URL: "https://cerebro.example/" })).toMatchObject({
      resource: "https://cerebro.example/api/mcp",
      resourceMetadataUrl: "https://cerebro.example/.well-known/oauth-protected-resource/api/mcp",
    });
  });

  it("answers 401 with a resource_metadata challenge when no token is sent", async () => {
    const res = await listTools();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toMatch(/^Bearer realm="cerebro"/);
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(challenge).toContain('scope="cerebro:read cerebro:draft cerebro:publish"');
    expect(challenge).not.toContain("error=");
  });
});

describe("access-token verification", () => {
  it("accepts a valid token, maps sub through the identity link, and records a revocable grant", async () => {
    const client = await connectClient(await token());
    const ctx = (await client.callTool({ name: "get_authoring_context", arguments: {} })) as { isError?: boolean; structuredContent: any };
    expect(ctx.isError).toBeFalsy();
    expect(ctx.structuredContent.company.name).toBe("Acme");
    expect(ctx.structuredContent.user.displayName).toBe("Maya Chen");

    const draft = (await client.callTool({
      name: "create_brief_draft",
      arguments: { handoff: platformHandoff(), idempotency_key: "oauth-key-0001" },
    })) as { isError?: boolean; structuredContent: any };
    expect(draft.isError).toBeFalsy();
    expect(draft.structuredContent.status).toBe("draft");
    await client.close();

    const conns = await oauthConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      organizationId: w.seed.orgs.acme.id,
      userId: w.seed.users.maya,
      clientId: "host-a",
      issuer: ISSUER,
      status: "active",
      tokenHash: null,
      scopes: ["cerebro:draft", "cerebro:publish", "cerebro:read"],
    });
    expect(conns[0]!.lastUsedAt).not.toBeNull();
    // The user sees it in Settings → Connections like a connection token.
    const listed = await listConnections(w.h.db, w.ctx("maya"));
    expect(listed.map((c) => c.kind)).toEqual(["oauth"]);
    // Audited, without the token.
    const audit = await withSystemContext(w.h.db, (tx) =>
      tx.execute<{ metadata: unknown }>(sql`select metadata from audit_events where action = 'connection.created'`),
    );
    expect(audit.rows).toEqual([{ metadata: { kind: "oauth", clientId: "host-a" } }]);
  });

  it("accepts an audience array that contains the resource", async () => {
    expect((await listTools(await token({ aud: ["https://other.example/api", MCP_URL] }))).status).toBe(200);
  });

  it.each([
    ["wrong audience", { aud: "https://other.example/api/mcp" }, /Invalid access token/],
    ["wrong issuer", { iss: "https://evil.example.test" }, /Invalid access token/],
    ["expired", { exp: nowSec() - 120 }, /expired/],
    ["unknown signing key", { key: undefined as unknown as CryptoKey, stranger: true }, /Invalid access token/],
    ["no client", { clientId: null }, /Invalid access token/],
  ] as const)("refuses a token with %s (401 invalid_token)", async (_label, opts, message) => {
    const o = { ...opts } as TokenOpts & { stranger?: boolean };
    if (o.stranger) o.key = strangerKey;
    const res = await listTools(await token(o));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(await res.text()).toMatch(message);
    expect(await oauthConnections()).toHaveLength(0);
  });

  it("refuses an unsigned or HMAC token", async () => {
    const hmac = await new SignJWT({ scope: ALL, client_id: "host-a" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(MCP_URL)
      .setSubject("sub-maya")
      .setExpirationTime(nowSec() + 300)
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough!!"));
    expect((await listTools(hmac)).status).toBe(401);
    const payload = hmac.split(".")[1];
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.`;
    expect((await listTools(none)).status).toBe(401);
  });

  it("refuses an unknown subject without provisioning anyone", async () => {
    const res = await listTools(await token({ sub: "sub-stranger" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/not linked to a Cerebro user/);
    expect(await oauthConnections()).toHaveLength(0);
  });

  it("refuses OAuth tokens entirely while CEREBRO_OAUTH_ISSUER is unset", async () => {
    const res = await listTools(await token(), { NODE_ENV: "test", APP_URL });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });

  it("works in production, where dev connection tokens stay refused", async () => {
    expect((await listTools(await token(), PROD_ENV)).status).toBe(200);
    const dev = await listTools("cbr_" + "a".repeat(43), PROD_ENV);
    expect(dev.status).toBe(401);
    expect(await dev.text()).toMatch(/disabled in production/);
    expect(dev.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA_URL}"`);
  });
});

describe("scopes", () => {
  it("every tool requires a declared scope", async () => {
    const client = await connectClient(await token());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_SCOPES).sort());
    await client.close();
    expect(TOOL_SCOPES.publish_brief).toBe("cerebro:publish");
    expect(TOOL_SCOPES.create_brief_draft).toBe("cerebro:draft");
    expect(TOOL_SCOPES.get_brief).toBe("cerebro:read");
  });

  it("answers 403 insufficient_scope for publish without cerebro:publish, but allows granted tools", async () => {
    const bearer = await token({ scope: "cerebro:read cerebro:draft" });
    const publish = await send(
      rpc(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "publish_brief", arguments: { briefing_id: crypto.randomUUID(), preview_id: crypto.randomUUID(), idempotency_key: "k-12345678" } },
        },
        bearer,
      ),
    );
    expect(publish.status).toBe(403);
    const challenge = publish.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="cerebro:read cerebro:draft cerebro:publish"');
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);

    // A batch hiding a publish call is refused as a whole.
    const batch = await send(
      rpc(
        [
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_authoring_context", arguments: {} } },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "publish_brief", arguments: {} } },
        ],
        bearer,
      ),
    );
    expect(batch.status).toBe(403);

    const client = await connectClient(bearer);
    const r = (await client.callTool({ name: "get_authoring_context", arguments: {} })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    await client.close();

    const readOnly = await token({ scope: "cerebro:read" });
    const draft = await send(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_brief_draft", arguments: {} } }, readOnly),
    );
    expect(draft.status).toBe(403);
    expect(draft.headers.get("www-authenticate")).toContain('scope="cerebro:read cerebro:draft"');
  });

  it("the server re-checks the scope per tool (defense in depth)", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createCerebroMcpServer({
      db: w.h.db,
      ctx: { ...w.ctx("maya"), via: "mcp" },
      appUrl: APP_URL,
      scopes: new Set<McpScope>(["cerebro:read"]),
    });
    await server.connect(serverSide);
    const client = new Client({ name: "in-memory", version: "1.0.0" });
    await client.connect(clientSide);
    const r = (await client.callTool({
      name: "publish_brief",
      arguments: { briefing_id: crypto.randomUUID(), preview_id: crypto.randomUUID(), idempotency_key: "k-12345678" },
    })) as { isError?: boolean; structuredContent: any };
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "forbidden", details: { reason: "insufficient_scope", scope: "cerebro:publish" } });
    const ok = (await client.callTool({ name: "get_authoring_context", arguments: {} })) as { isError?: boolean };
    expect(ok.isError).toBeFalsy();
    await client.close();
    await server.close();
  });
});

describe("grants and revocation", () => {
  it("a revoked grant refuses tokens until the user authorizes again", async () => {
    const before = nowSec() - 60;
    const old = await token({ authTime: before });
    expect((await listTools(old)).status).toBe(200);
    const [conn] = await oauthConnections();

    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id });
    const refused = await listTools(old);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toMatch(/revoked/);
    // A token refreshed from the revoked grant (new iat, same auth_time) is refused too.
    expect((await listTools(await token({ authTime: before }))).status).toBe(401);

    // A fresh authorization (auth_time after the revocation) creates a new grant…
    const fresh = await token({ authTime: nowSec() + 5 });
    expect((await listTools(fresh)).status).toBe(200);
    const conns = await oauthConnections();
    expect(conns.map((c) => c.status).sort()).toEqual(["active", "revoked"]);
    expect(conns.find((c) => c.status === "active")!.notBefore).not.toBeNull();
    // …and older tokens stay refused.
    expect((await listTools(old)).status).toBe(401);
  });

  it("refuses tokens without auth_time after a revocation (fails closed)", async () => {
    expect((await listTools(await token())).status).toBe(200);
    const [conn] = await oauthConnections();
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id });
    const noAuthTime = await new SignJWT({ scope: ALL, client_id: "host-a" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(MCP_URL)
      .setSubject("sub-maya")
      .setIssuedAt()
      .setExpirationTime(nowSec() + 300)
      .sign(signingKey);
    expect((await listTools(noAuthTime)).status).toBe(401);
  });

  it("grants are per client: revoking one host leaves another connected", async () => {
    expect((await listTools(await token({ clientId: "host-a" }))).status).toBe(200);
    expect((await listTools(await token({ clientId: "host-b" }))).status).toBe(200);
    const a = (await oauthConnections()).find((c) => c.clientId === "host-a")!;
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: a.id });
    expect((await listTools(await token({ clientId: "host-a" }))).status).toBe(401);
    expect((await listTools(await token({ clientId: "host-b" }))).status).toBe(200);
  });

  it("losing company membership ends access on the next request", async () => {
    expect((await listTools(await token({ sub: "sub-alex" }))).status).toBe(200);
    await withSystemContext(w.h.db, (tx) =>
      tx
        .update(memberships)
        .set({ status: "removed" })
        .where(and(eq(memberships.userId, w.seed.users.alex), eq(memberships.organizationId, w.seed.orgs.acme.id))),
    );
    expect((await listTools(await token({ sub: "sub-alex" }))).status).toBe(401);
  });

  it("refuses a user in several companies until a company is chosen (no guessing)", async () => {
    await withSystemContext(w.h.db, (tx) =>
      tx.insert(memberships).values({ organizationId: w.seed.orgs.globex.id, userId: w.seed.users.maya, role: "member", status: "active" }),
    );
    const res = await listTools(await token());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden", details: { reason: "company_selection_required" } } });
    expect(await oauthConnections()).toHaveLength(0);
  });
});
