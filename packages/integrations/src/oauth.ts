/**
 * MCP as an OAuth 2.1 protected resource (MCP authorization spec, W2.2).
 *
 * Cerebro is only the resource server. It does not issue tokens:
 * `CEREBRO_OAUTH_ISSUER` names the authorization server (Clerk, D13), and
 * while it is unset the OAuth path is off (no metadata, every JWT refused).
 *
 * - Protected Resource Metadata (RFC 9728) at
 *   `/.well-known/oauth-protected-resource/api/mcp` (and the root form).
 * - 401 responses carry `WWW-Authenticate: Bearer resource_metadata=…`.
 * - Bearer access tokens must be JWTs signed by a key in the issuer's JWKS,
 *   with `iss` = the configured issuer, `aud` containing the MCP resource
 *   URL (RFC 8707 audience binding; tokens for other resources are refused,
 *   never passed through), a valid `exp`, a `sub`, and a client (`client_id`;
 *   `azp` only in the generic profile). Scopes come from `scope` (RFC 9068)
 *   or `scp`.
 * - The subject maps to a Cerebro user only through an explicit identity link,
 *   and the grant is a revocable `integration_connections` row (domain:
 *   `authenticateOAuthGrant`).
 *
 * Profiles (`CEREBRO_OAUTH_PROFILE`):
 *
 * - `clerk` (default, D13). Clerk signs OAuth access tokens and session
 *   tokens with the same instance keys and issuer, so the token type is what
 *   tells them apart: the header `typ` must be `at+jwt` (RFC 9068), which
 *   Clerk sets on OAuth access tokens and not on session or M2M tokens. The
 *   client is the `client_id` claim only (Clerk's `azp` is the frontend
 *   origin, not the OAuth client). The audience is the RFC 8707 `resource`
 *   the host requested, which Clerk copies into `aud` when the instance
 *   setting `aud_claim_enabled` is on; without it tokens carry no `aud` and
 *   are refused. Clerk access tokens carry no `auth_time`; see
 *   `authenticateOAuthGrant` for how revocation stays fail-closed without it.
 * - `generic`: any RFC 9068-style authorization server. `typ` is not
 *   required and the client may come from `azp`.
 *
 * In both, tokens carrying an RFC 8693 actor (`act`, from token exchange)
 * are refused: Cerebro has no delegation chains.
 *
 * Opaque access tokens (Clerk `oat_…`) are refused: they would need a call
 * to the authorization server per request. Clerk must issue JWT access
 * tokens (its default for new instances).
 *
 * Tokens and claims are never logged.
 */
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { isMcpScope, MCP_SCOPES, type McpScope } from "./scopes";

/** Path of the MCP endpoint, relative to the app URL. */
export const MCP_PATH = "/api/mcp";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** Asymmetric algorithms only; `none` and shared-secret HMAC are never accepted. */
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/** RFC 9068 access-token type; jose also accepts `application/at+jwt`. */
const ACCESS_TOKEN_TYP = "at+jwt";

type Env = Record<string, string | undefined>;

export type OAuthProfile = "clerk" | "generic";
export const OAUTH_PROFILES: readonly OAuthProfile[] = ["clerk", "generic"];

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

export interface OAuthResourceConfig {
  /** Token rules for the authorization server: `clerk` unless `CEREBRO_OAUTH_PROFILE=generic`. */
  profile: OAuthProfile;
  /** Authorization server issuer identifier (exact `iss`). */
  issuer: string;
  /** Canonical MCP resource URL; access tokens must carry it as audience. */
  resource: string;
  /** Where clients fetch this resource's metadata (RFC 9728 path-inserted form). */
  resourceMetadataUrl: string;
  /** Optional explicit JWKS URL; otherwise discovered from the issuer's metadata. */
  jwksUrl: string | undefined;
}

/**
 * OAuth resource configuration, or null when the OAuth path is off.
 *
 * The resource URL comes only from `APP_URL`. Without it OAuth stays off, in
 * every environment: deriving the audience from the request origin would let a
 * client-controlled Host header choose which tokens are accepted.
 *
 * An unknown `CEREBRO_OAUTH_PROFILE` throws `OAuthConfigError` instead of
 * falling back to looser rules.
 */
export function oauthConfig(env: Env = process.env): OAuthResourceConfig | null {
  const issuer = env.CEREBRO_OAUTH_ISSUER?.trim();
  if (!issuer) return null;
  const base = (env.APP_URL?.trim() ?? "").replace(/\/+$/, "");
  if (!base) return null;
  const profile = env.CEREBRO_OAUTH_PROFILE?.trim().toLowerCase() || "clerk";
  if (!(OAUTH_PROFILES as readonly string[]).includes(profile)) {
    throw new OAuthConfigError(`Unknown CEREBRO_OAUTH_PROFILE "${profile}". Use "clerk" or "generic".`);
  }
  return {
    profile: profile as OAuthProfile,
    issuer,
    resource: `${base}${MCP_PATH}`,
    resourceMetadataUrl: `${base}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
    jwksUrl: env.CEREBRO_OAUTH_JWKS_URL?.trim() || undefined,
  };
}

/** RFC 9728 metadata document for the MCP resource. */
export function protectedResourceMetadata(cfg: OAuthResourceConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cerebro",
  };
}

/**
 * Serve `/.well-known/oauth-protected-resource[/api/mcp]`. 404 while OAuth is
 * not configured, so nothing advertises an authorization server that does
 * not exist.
 */
export function protectedResourceMetadataResponse(opts: { env?: Env; appUrl?: string } = {}): Response {
  const cfg = oauthConfig(opts.env ?? process.env);
  if (!cfg) {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "OAuth is not configured for this deployment." } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(protectedResourceMetadata(cfg)), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// Key discovery
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;
const keySets = new Map<string, Promise<JWTVerifyGetKey>>();

/**
 * Upper bound for one metadata request. Discovery is shared by every request
 * through `keySets`, so a hanging authorization server must fail (and be
 * retried later) rather than leave one pending promise that stalls them all.
 */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** Find `jwks_uri` in the issuer's RFC 8414 or OpenID metadata; the metadata must name the same issuer. */
async function discoverJwksUri(issuer: string, fetchFn: FetchFn, timeoutMs: number): Promise<string> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
  for (const url of [...new Set(candidates)]) {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchFn(url, { headers: { accept: "application/json" }, signal }).catch(() => null);
    if (!res?.ok) continue;
    const meta = (await res.json().catch(() => null)) as { issuer?: unknown; jwks_uri?: unknown } | null;
    if (meta?.issuer === issuer && typeof meta.jwks_uri === "string") return meta.jwks_uri;
  }
  throw new Error("authorization server metadata with a matching issuer and jwks_uri was not found");
}

function keySetFor(cfg: OAuthResourceConfig, fetchFn: FetchFn, timeoutMs: number): Promise<JWTVerifyGetKey> {
  const cacheKey = `${cfg.issuer}\n${cfg.jwksUrl ?? ""}`;
  let p = keySets.get(cacheKey);
  if (!p) {
    p = (async () =>
      createRemoteJWKSet(new URL(cfg.jwksUrl ?? (await discoverJwksUri(cfg.issuer, fetchFn, timeoutMs))), {
        timeoutDuration: timeoutMs,
        [customFetch]: fetchFn,
      }))();
    p.catch(() => keySets.delete(cacheKey));
    keySets.set(cacheKey, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Access-token verification
// ---------------------------------------------------------------------------

export interface VerifiedAccessToken {
  issuer: string;
  subject: string;
  clientId: string;
  /** Recognized Cerebro scopes granted by the token. */
  scopes: Set<McpScope>;
  /** `auth_time`, when the authorization server sends it (Clerk does not). */
  authTime: Date | null;
  /** `iat`, when present. */
  issuedAt: Date | null;
}

export type AccessTokenFailure = "expired" | "invalid" | "opaque";

export interface VerifyOptions {
  /** Test seam: a key resolver (e.g. jose `createLocalJWKSet`). Defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
  fetch?: FetchFn;
  /** Test seam: per-request timeout for authorization server metadata discovery. */
  discoveryTimeoutMs?: number;
}

function scopesOf(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  const list = typeof raw === "string" ? raw.split(" ") : Array.isArray(raw) ? raw : [];
  return [...new Set(list.filter((s): s is string => typeof s === "string" && s.length > 0))];
}

/** Verify a bearer JWT for this resource. Never throws for a bad token; never logs it. */
export async function verifyAccessToken(
  token: string,
  cfg: OAuthResourceConfig,
  opts: VerifyOptions = {},
): Promise<{ ok: true; token: VerifiedAccessToken } | { ok: false; reason: AccessTokenFailure }> {
  // A compact JWS has three segments; anything else (e.g. Clerk's `oat_…`) is opaque.
  if (token.split(".").length !== 3) return { ok: false, reason: "opaque" };
  let payload: JWTPayload;
  try {
    const getKey = opts.getKey ?? (await keySetFor(cfg, opts.fetch ?? fetch, opts.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS));
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: cfg.issuer,
      audience: cfg.resource,
      algorithms: ALGORITHMS,
      requiredClaims: ["sub", "exp"],
      ...(cfg.profile === "clerk" ? { typ: ACCESS_TOKEN_TYP } : {}),
    }));
  } catch (e) {
    return { ok: false, reason: e instanceof joseErrors.JWTExpired ? "expired" : "invalid" };
  }
  const clientId =
    typeof payload.client_id === "string"
      ? payload.client_id
      : cfg.profile === "generic" && typeof payload.azp === "string"
        ? payload.azp
        : "";
  if (!payload.sub || !clientId) return { ok: false, reason: "invalid" };
  if (payload.act !== undefined) return { ok: false, reason: "invalid" };
  const granted = scopesOf(payload).filter(isMcpScope);
  return {
    ok: true,
    token: {
      issuer: cfg.issuer,
      subject: payload.sub,
      clientId,
      scopes: new Set(granted),
      authTime: typeof payload.auth_time === "number" ? new Date(payload.auth_time * 1000) : null,
      issuedAt: typeof payload.iat === "number" ? new Date(payload.iat * 1000) : null,
    },
  };
}
