/**
 * Clerk as the MCP authorization server (D13), with no network.
 *
 * The fixtures reproduce what a Clerk instance actually serves:
 * - authorization server metadata at `<Frontend API>/.well-known/oauth-authorization-server`
 *   whose `issuer` is the Frontend API URL and whose `jwks_uri` is
 *   `<Frontend API>/.well-known/jwks.json` (Clerk docs, "How Clerk implements OAuth");
 * - RS256 OAuth access tokens with header `typ: at+jwt` and a `kid` like
 *   `ins_…`, and the claims Clerk puts in them: `iss`, `sub` (Clerk user id),
 *   `client_id`, `scope`, `jti` (`oat_…`), `iat`, `nbf`, `exp`, `sid`, `azp`
 *   (the frontend origin, not the OAuth client), no `auth_time`, and `aud`
 *   only when the host sent an RFC 8707 `resource` and the instance has
 *   `aud_claim_enabled` (shape from @clerk/backend's own fixtures);
 * - Clerk session tokens, signed by the same keys with the same issuer but
 *   without `typ: at+jwt` or `client_id`.
 */
import { listConnections, reconnectOAuthConnection, removeMembership, resolveWebIdentity, revokeConnection } from "@cerebro/domain";
import { integrationConnections, withSystemContext } from "@cerebro/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConnectionToken } from "@cerebro/domain";
import { createTestWorld, type TestWorld } from "../../domain/src/testing";
import { handleMcpHttpRequest, MCP_SCOPES, oauthConfig, OAuthConfigError, protectedResourceMetadataResponse, verifyAccessToken } from "../src/index";
import { APP_URL, MCP_URL, platformHandoff } from "./helpers";

/** A Clerk development instance's Frontend API URL: the issuer of both session and OAuth tokens. */
const FAPI = "https://cerebro-test-42.clerk.accounts.dev";
const KID = "ins_2GIoQhbUpy0hX7B2cVkuTMinXoD";
const CLIENT = "client_2VTWUzvGC5UhdJCNx6xG1D98edc";
const MAYA = "user_2vYVmayaMAYAmayaMAYAmayaMAYA";
const ALEX = "user_2vYValexALEXalexALEXalexALEX";
const ENV = { NODE_ENV: "production", CEREBRO_OAUTH_ISSUER: FAPI, APP_URL };
const ALL = MCP_SCOPES.join(" ");

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };
const fetched: string[] = [];

/** Clerk's public endpoints, served locally. */
const clerkFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === `${FAPI}/.well-known/oauth-authorization-server`) {
    return json({
      issuer: FAPI,
      authorization_endpoint: `${FAPI}/oauth/authorize`,
      token_endpoint: `${FAPI}/oauth/token`,
      registration_endpoint: `${FAPI}/oauth/register`,
      jwks_uri: `${FAPI}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name", "org_id"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url === `${FAPI}/.well-known/jwks.json`) return json(jwks);
  return new Response("not found", { status: 404 });
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] };
});

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  await w.h.close();
});

const nowSec = () => Math.floor(Date.now() / 1000);

interface ClerkTokenOpts {
  sub?: string;
  /** RFC 8707 resource copied into `aud`; null = no `aud` (aud_claim_enabled off). */
  aud?: string | null;
  scope?: string;
  clientId?: string | null;
  typ?: string | null;
  iat?: number;
  extra?: Record<string, unknown>;
}

/** An OAuth access token as Clerk issues it (JWT access token format). */
function clerkAccessToken(o: ClerkTokenOpts = {}): Promise<string> {
  const iat = o.iat ?? nowSec();
  const claims: Record<string, unknown> = {
    azp: "https://accounts.cerebro.example",
    sid: "sess_2GbDB4enNdCa5vS1zpC3Xzg9tK9",
    jti: `oat_${crypto.randomUUID().replaceAll("-", "")}`,
    scope: o.scope ?? ALL,
    nbf: iat - 10,
    ...o.extra,
  };
  if (o.clientId !== null) claims.client_id = o.clientId ?? CLIENT;
  if (o.aud !== null) claims.aud = o.aud ?? MCP_URL;
  const header: Record<string, string> = { alg: "RS256", kid: KID };
  if (o.typ !== null) header.typ = o.typ ?? "at+jwt";
  return new SignJWT(claims)
    .setProtectedHeader(header as { alg: string })
    .setIssuer(FAPI)
    .setSubject(o.sub ?? MAYA)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 86_400)
    .sign(privateKey);
}

const send = (req: Request, env: Record<string, string | undefined> = ENV) =>
  handleMcpHttpRequest(req, { db: w.h.db, appUrl: APP_URL, env, oauth: { fetch: clerkFetch } });

function rpc(body: unknown, bearer: string): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

const listTools = (bearer: string, env?: Record<string, string | undefined>) => send(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer), env);

async function connectClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => send(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "clerk-test-host", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Web sign-in as `clerk-identity.ts` records it: issuer = session `iss` (the Frontend API URL), subject = Clerk user id. */
async function webSignIn(user: "maya" | "alex", clerkUserId: string) {
  const email = `${user}@acme.example`;
  const res = await resolveWebIdentity(w.h.db, {
    issuer: FAPI,
    subject: clerkUserId,
    email,
    emailVerified: true,
    displayName: user,
    authSubject: `clerk|${clerkUserId}`,
  });
  expect(res.status).toBe("claimed");
  return res;
}

const oauthConnections = () =>
  withSystemContext(w.h.db, (tx) => tx.select().from(integrationConnections).where(eq(integrationConnections.kind, "oauth")));

describe("Clerk configuration", () => {
  it("defaults to the clerk profile and refuses an unknown profile", () => {
    expect(oauthConfig(ENV)?.profile).toBe("clerk");
    expect(oauthConfig({ ...ENV, CEREBRO_OAUTH_PROFILE: "generic" })?.profile).toBe("generic");
    expect(() => oauthConfig({ ...ENV, CEREBRO_OAUTH_PROFILE: "lenient" })).toThrow(OAuthConfigError);
  });

  it("advertises Clerk's Frontend API as the authorization server for APP_URL/api/mcp", async () => {
    const res = protectedResourceMetadataResponse({ env: ENV });
    expect(await res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [FAPI], scopes_supported: [...MCP_SCOPES] });
  });
});

describe("Clerk OAuth access tokens", () => {
  it("discovers Clerk's JWKS from its metadata and maps the web sign-in's Clerk user to the same Cerebro user", async () => {
    await webSignIn("maya", MAYA);
    const client = await connectClient(await clerkAccessToken());
    const ctx = (await client.callTool({ name: "get_authoring_context", arguments: {} })) as { isError?: boolean; structuredContent: any };
    expect(ctx.isError).toBeFalsy();
    expect(ctx.structuredContent.user.displayName).toBe("Maya Chen");
    const draft = (await client.callTool({
      name: "create_brief_draft",
      arguments: { handoff: platformHandoff(), idempotency_key: "clerk-key-0001" },
    })) as { isError?: boolean; structuredContent: any };
    expect(draft.isError).toBeFalsy();
    await client.close();

    expect(fetched).toContain(`${FAPI}/.well-known/oauth-authorization-server`);
    expect(fetched).toContain(`${FAPI}/.well-known/jwks.json`);
    const conns = await oauthConnections();
    expect(conns).toHaveLength(1);
    // The grant belongs to the user the web identity link names, under the OAuth client (not Clerk's `azp`).
    expect(conns[0]).toMatchObject({ userId: w.seed.users.maya, issuer: FAPI, clientId: CLIENT, status: "active" });
  });

  it("refuses a Clerk user who has never signed in to the web app (no identity link, nobody provisioned)", async () => {
    const res = await listTools(await clerkAccessToken());
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/not linked to a Cerebro user/);
    expect(await oauthConnections()).toHaveLength(0);
  });

  it.each([
    ["an audience for another resource", { aud: "https://other.example/api/mcp" }],
    ["no audience (aud_claim_enabled off, or no resource requested)", { aud: null }],
    ["the app origin instead of the MCP resource", { aud: APP_URL }],
    ["no typ header (a Clerk session token shape)", { typ: null }],
    ["typ JWT (a Clerk session or M2M token)", { typ: "JWT" }],
    ["no client_id (Clerk's azp is not an OAuth client)", { clientId: null }],
    ["an RFC 8693 actor (token exchange)", { extra: { act: { sub: "client_other" } } }],
  ] as const)("refuses a token with %s", async (_label, opts) => {
    await webSignIn("maya", MAYA);
    const res = await listTools(await clerkAccessToken(opts as ClerkTokenOpts));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await oauthConnections()).toHaveLength(0);
  });

  it("refuses a Clerk session token even when custom session claims add the MCP audience", async () => {
    await webSignIn("maya", MAYA);
    const session = await new SignJWT({ azp: APP_URL, sid: "sess_1", aud: MCP_URL })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(FAPI)
      .setSubject(MAYA)
      .setIssuedAt()
      .setExpirationTime(nowSec() + 60)
      .sign(privateKey);
    expect((await listTools(session)).status).toBe(401);
    // The generic profile would take `azp` as the client, which is why Clerk deployments use the clerk profile.
    expect((await listTools(session, { ...ENV, CEREBRO_OAUTH_PROFILE: "generic" })).status).toBe(200);
  });

  it("refuses opaque Clerk tokens with a message that names the fix", async () => {
    const res = await listTools(`oat_${"a".repeat(32)}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/only JWT access tokens/);
    const cfg = oauthConfig(ENV)!;
    expect(await verifyAccessToken("oat_abc", cfg, { fetch: clerkFetch })).toEqual({ ok: false, reason: "opaque" });
  });

  it("enforces Clerk custom scopes: a read-only grant cannot draft or publish", async () => {
    await webSignIn("maya", MAYA);
    const bearer = await clerkAccessToken({ scope: "openid profile cerebro:read" });
    expect((await listTools(bearer)).status).toBe(200);
    const draft = await send(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_brief_draft", arguments: {} } }, bearer));
    expect(draft.status).toBe(403);
    expect(draft.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(draft.headers.get("www-authenticate")).toContain('scope="cerebro:read cerebro:draft"');
    const [conn] = await oauthConnections();
    // Only Cerebro scopes are recorded; Clerk's built-in scopes are ignored.
    expect(conn!.scopes).toEqual(["cerebro:read"]);
  });
});

describe("revocation without auth_time (Clerk)", () => {
  it("a revoked grant stays refused, including refreshed tokens, until the user reconnects in Settings", async () => {
    await webSignIn("maya", MAYA);
    const old = await clerkAccessToken({ iat: nowSec() - 60 });
    expect((await listTools(old)).status).toBe(200);
    const [conn] = await oauthConnections();
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id });

    expect((await listTools(old)).status).toBe(401);
    // A token refreshed from the revoked grant (new iat, no auth_time) is refused, not taken for a fresh authorization.
    const refreshed = await listTools(await clerkAccessToken({ iat: nowSec() + 5 }));
    expect(refreshed.status).toBe(401);
    expect(await refreshed.text()).toMatch(/Settings > Connections/);
    expect(await oauthConnections()).toHaveLength(1);

    // The user reconnects explicitly in their web session.
    const reconnected = await reconnectOAuthConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id });
    expect(reconnected.status).toBe("active");
    // Tokens issued before the reconnection stay refused…
    expect((await listTools(old)).status).toBe(401);
    expect((await listTools(await clerkAccessToken({ iat: nowSec() - 1 }))).status).toBe(401);
    // …tokens issued after it are accepted, on the same connection.
    expect((await listTools(await clerkAccessToken({ iat: nowSec() + 2 }))).status).toBe(200);
    const conns = await oauthConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]!.issuedAfter).not.toBeNull();
    const audit = await withSystemContext(w.h.db, (tx) =>
      tx.execute<{ metadata: unknown }>(sql`select metadata from audit_events where action = 'connection.reconnected'`),
    );
    expect(audit.rows).toEqual([{ metadata: { kind: "oauth", clientId: CLIENT } }]);
  });

  it("only the owner can reconnect, only OAuth connections, never from MCP, and not while the client has another active grant", async () => {
    await webSignIn("maya", MAYA);
    expect((await listTools(await clerkAccessToken())).status).toBe(200);
    const [conn] = await oauthConnections();
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id });

    await expect(reconnectOAuthConnection(w.h.db, w.ctx("alex"), { connectionId: conn!.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(reconnectOAuthConnection(w.h.db, { ...w.ctx("maya"), via: "mcp" }, { connectionId: conn!.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    const { connection: dev } = await createConnectionToken(w.h.db, w.ctx("maya"), { label: "Dev" });
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: dev.id });
    await expect(reconnectOAuthConnection(w.h.db, w.ctx("maya"), { connectionId: dev.id })).rejects.toMatchObject({ code: "validation" });

    // Another active grant for the same client and company (e.g. from the generic auth_time path) blocks reconnecting this one.
    await withSystemContext(w.h.db, (tx) =>
      tx.insert(integrationConnections).values({
        organizationId: w.seed.orgs.acme.id,
        userId: w.seed.users.maya,
        kind: "oauth",
        label: "Other",
        clientId: CLIENT,
        issuer: FAPI,
        status: "active",
      }),
    );
    await expect(reconnectOAuthConnection(w.h.db, w.ctx("maya"), { connectionId: conn!.id })).rejects.toMatchObject({ code: "conflict" });
    expect((await listConnections(w.h.db, w.ctx("maya"))).find((c) => c.id === conn!.id)!.status).toBe("revoked");
  });

  it("membership removal revokes the Clerk grant on the next request", async () => {
    await webSignIn("alex", ALEX);
    expect((await listTools(await clerkAccessToken({ sub: ALEX }))).status).toBe(200);
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.alex });
    expect((await listTools(await clerkAccessToken({ sub: ALEX, iat: nowSec() + 5 }))).status).toBe(401);
    const [conn] = await oauthConnections();
    expect(conn!.status).toBe("revoked");
  });
});
