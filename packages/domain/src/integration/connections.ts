/**
 * MCP connections (D08).
 *
 * - Connection tokens (`kind = 'dev_token'`): the dev/test stand-in for
 *   delegated MCP authorization. Production must not accept these. Tokens
 *   look like `cbr_<base62>` (32 random bytes), are shown once, and are
 *   stored only as a SHA-256 hash plus a short non-secret prefix.
 * - OAuth grants (`kind = 'oauth'`): the production path. The MCP adapter
 *   verifies the access token; `authenticateOAuthGrant` maps it to a user
 *   and a revocable per-company connection.
 */
import { randomUUID } from "node:crypto";
import { withAuthContext, withSystemContext, type Database, type Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { isUniqueViolation, parseInput, randomBase62, requireMember, sha256Hex, toDate, toDateOrNull, Uuid, withCtx } from "../org/shared";

export const CONNECTION_TOKEN_PREFIX = "cbr_";
const TOKEN_PATTERN = /^cbr_[0-9A-Za-z]{43,64}$/;
/** Characters of the token kept as a display prefix (e.g. `cbr_1a2B3c4D`). */
const DISPLAY_PREFIX_LENGTH = 12;

export interface ConnectionDTO {
  id: string;
  label: string;
  kind: "dev_token" | "oauth";
  clientId: string;
  /** Non-secret token prefix shown in Settings, e.g. "cbr_1a2B3c4D". */
  tokenPrefix: string | null;
  status: "active" | "revoked";
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface ConnRow extends Record<string, unknown> {
  id: string;
  label: string;
  kind: "dev_token" | "oauth";
  client_id: string;
  token_prefix: string | null;
  status: "active" | "revoked";
  last_used_at: unknown;
  revoked_at: unknown;
  created_at: unknown;
}

const COLS = sql`id, label, kind, client_id, token_prefix, status, last_used_at, revoked_at, created_at`;

const toConnection = (r: ConnRow): ConnectionDTO => ({
  id: r.id,
  label: r.label,
  kind: r.kind,
  clientId: r.client_id,
  tokenPrefix: r.token_prefix,
  status: r.status,
  lastUsedAt: toDateOrNull(r.last_used_at),
  revokedAt: toDateOrNull(r.revoked_at),
  createdAt: toDate(r.created_at),
});

const CreateInput = z.object({ label: z.string().trim().min(1).max(100) });

export async function createConnectionTokenInTx(
  tx: Tx,
  ctx: RequestContext,
  input: { label: string },
): Promise<{ connection: ConnectionDTO; token: string }> {
  const { label } = parseInput(CreateInput, input);
  if (ctx.via === "mcp") throw new DomainError("forbidden", "Connection tokens are created in Settings.");
  await requireMember(tx, ctx);
  const token = `${CONNECTION_TOKEN_PREFIX}${randomBase62(32)}`;
  const row = (
    await tx.execute<ConnRow>(sql`
      insert into integration_connections (organization_id, user_id, kind, label, client_id, status, token_hash, token_prefix)
      values (${ctx.organizationId}::uuid, ${ctx.userId}::uuid, 'dev_token', ${label}, 'dev', 'active',
              ${sha256Hex(token)}, ${token.slice(0, DISPLAY_PREFIX_LENGTH)})
      returning ${COLS}`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "connection.created", targetType: "integration_connection", targetId: row.id, metadata: { kind: "dev_token" } });
  return { connection: toConnection(row), token };
}

/** Create a connection token for the current user. The plaintext token is returned once. */
export const createConnectionToken = (db: Database, ctx: RequestContext, input: { label: string }) =>
  withCtx(db, ctx, (tx, c) => createConnectionTokenInTx(tx, c, input));

export async function listConnectionsInTx(tx: Tx, ctx: RequestContext): Promise<ConnectionDTO[]> {
  await requireMember(tx, ctx);
  const res = await tx.execute<ConnRow>(sql`
    select ${COLS} from integration_connections
    where organization_id = ${ctx.organizationId}::uuid and user_id = ${ctx.userId}::uuid
    order by created_at desc, id`);
  return res.rows.map(toConnection);
}

/** The current user's own connections in this company. */
export const listConnections = (db: Database, ctx: RequestContext) => withCtx(db, ctx, (tx, c) => listConnectionsInTx(tx, c));

const RevokeInput = z.object({ connectionId: Uuid });

export async function revokeConnectionInTx(tx: Tx, ctx: RequestContext, input: { connectionId: string }): Promise<ConnectionDTO> {
  const { connectionId } = parseInput(RevokeInput, input);
  // Revoking your own connection does not require active membership.
  const existing = (
    await tx.execute<ConnRow>(sql`
      select ${COLS} from integration_connections
      where organization_id = ${ctx.organizationId}::uuid and user_id = ${ctx.userId}::uuid and id = ${connectionId}::uuid`)
  ).rows[0];
  if (!existing) throw new DomainError("not_found", "Connection not found.");
  if (existing.status === "revoked") return toConnection(existing);
  const row = (
    await tx.execute<ConnRow>(sql`
      update integration_connections set status = 'revoked', revoked_at = now(), updated_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${connectionId}::uuid
      returning ${COLS}`)
  ).rows[0]!;
  await recordAudit(tx, ctx, { action: "connection.revoked", targetType: "integration_connection", targetId: connectionId });
  return toConnection(row);
}

/** Revoke one of the current user's connections; the token stops working on the next request. */
export const revokeConnection = (db: Database, ctx: RequestContext, input: { connectionId: string }) =>
  withCtx(db, ctx, (tx, c) => revokeConnectionInTx(tx, c, input));

const unauthenticated = () => new DomainError("unauthenticated", "Invalid or revoked connection token.");

/**
 * Map a bearer connection token to a RequestContext (`via: "mcp"`). Rejects
 * malformed, unknown and revoked tokens, and tokens whose user no longer has
 * an active membership in the connection's company. Updates `last_used_at`.
 */
export async function authenticateConnectionToken(db: Database, token: string): Promise<RequestContext> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw unauthenticated();
  const tokenHash = sha256Hex(token);
  // System context: narrow identity lookup resolving a connection-token hash
  // to its user and company (allowed by the database package). No tenant is
  // known before this lookup; only ids and status flags are read.
  const found = await withSystemContext(db, async (tx) => {
    const res = await tx.execute<{ id: string; organization_id: string; user_id: string; status: string; revoked_at: unknown; member_active: boolean }>(sql`
      select c.id, c.organization_id, c.user_id, c.status, c.revoked_at,
        exists (select 1 from memberships m where m.organization_id = c.organization_id
                  and m.user_id = c.user_id and m.status = 'active') as member_active
      from integration_connections c
      where c.token_hash = ${tokenHash} and c.kind = 'dev_token'`);
    return res.rows[0] ?? null;
  });
  if (!found || found.status !== "active" || found.revoked_at !== null || !found.member_active) throw unauthenticated();
  return touchConnection(db, found.user_id, found.organization_id, found.id);
}

/** Re-check and touch a connection under the runtime role; returns the MCP RequestContext. */
async function touchConnection(
  db: Database,
  userId: string,
  organizationId: string,
  connectionId: string,
  scopes?: readonly string[],
): Promise<RequestContext> {
  const ctx: RequestContext = { userId, organizationId, via: "mcp", connectionId, requestId: randomUUID() };
  await withAuthContext(db, { userId, organizationId, connectionId }, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      update integration_connections set last_used_at = now()
        ${scopes ? sql`, scopes = ${JSON.stringify([...scopes].sort())}::jsonb` : sql``}
      where organization_id = ${organizationId}::uuid and id = ${connectionId}::uuid
        and status = 'active' and revoked_at is null
      returning id`);
    if (!res.rows[0]) throw unauthenticated();
  });
  return ctx;
}

// ---------------------------------------------------------------------------
// OAuth grants (D08 production path, W2.2)
// ---------------------------------------------------------------------------

/**
 * Claims from an access token that the MCP adapter has already verified
 * (signature, issuer, audience, expiry). Nothing here is a credential.
 */
export const OAuthGrantClaims = z.object({
  issuer: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
  /** OAuth client the token was issued to (`client_id`, or `azp`). */
  clientId: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().min(1).max(100)).max(50),
  /**
   * When the user last authenticated at the authorization server (`auth_time`),
   * or null when the token does not say. Refresh does not change it, so it is
   * what distinguishes a fresh authorization from a token refreshed from a
   * revoked grant.
   */
  authTime: z.date().nullable(),
});
export type OAuthGrantClaims = z.infer<typeof OAuthGrantClaims>;

interface OAuthConnRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  status: "active" | "revoked";
  revoked_at: unknown;
  not_before: unknown;
}

const oauthRefused = (message: string, reason: string) => new DomainError("unauthenticated", message, { reason });

/**
 * Map a verified OAuth access token to a RequestContext (`via: "mcp"`).
 *
 * - The subject must be linked to a Cerebro user (`user_identities`); unknown
 *   subjects are refused, never provisioned here.
 * - The grant is recorded as an `integration_connections` row (kind `oauth`)
 *   per company, user, issuer and client, so Settings lists it and
 *   revocation works like connection tokens: a revoked grant refuses every
 *   token until the user authorizes again (a later `auth_time`).
 * - A connection is bound to one company. On first use it binds to the user's
 *   only active company; users in several companies are refused
 *   (`company_selection_required`) until a company-selection step exists.
 * - Active membership is rechecked on every request.
 */
export async function authenticateOAuthGrant(db: Database, claims: OAuthGrantClaims): Promise<RequestContext> {
  const c = parseInput(OAuthGrantClaims, claims);
  // System context: narrow identity lookup resolving a verified (issuer,
  // subject) to its user, the user's active companies and this client's
  // grants. No tenant is known before this lookup; only ids, statuses and
  // timestamps are read.
  const found = await withSystemContext(db, async (tx) => {
    const user = (
      await tx.execute<{ user_id: string }>(sql`
        select user_id from user_identities where issuer = ${c.issuer} and subject = ${c.subject}`)
    ).rows[0];
    if (!user) return null;
    const orgs = (
      await tx.execute<{ organization_id: string }>(sql`
        select organization_id from memberships where user_id = ${user.user_id}::uuid and status = 'active'
        order by organization_id`)
    ).rows.map((r) => r.organization_id);
    const conns = (
      await tx.execute<OAuthConnRow>(sql`
        select id, organization_id, status, revoked_at, not_before from integration_connections
        where kind = 'oauth' and user_id = ${user.user_id}::uuid and issuer = ${c.issuer} and client_id = ${c.clientId}
        order by created_at desc, id`)
    ).rows;
    return { userId: user.user_id, orgs, conns };
  });
  if (!found) throw oauthRefused("This account is not linked to a Cerebro user.", "unknown_subject");
  const { userId, orgs, conns } = found;
  if (orgs.length === 0) throw oauthRefused("This account has no active Cerebro company.", "no_membership");

  const authAfter = (instant: unknown) => c.authTime !== null && c.authTime > toDate(instant);
  const active = conns.filter((r) => r.status === "active" && orgs.includes(r.organization_id));
  if (active.length > 1) {
    throw new DomainError("forbidden", "This client is connected to more than one company.", { reason: "company_selection_required" });
  }
  if (active.length === 1) {
    const conn = active[0]!;
    if (conn.not_before !== null && !authAfter(conn.not_before)) {
      throw oauthRefused("This connection was revoked. Reconnect Cerebro.", "revoked");
    }
    return touchConnection(db, userId, conn.organization_id, conn.id, c.scopes);
  }

  if (orgs.length > 1) {
    throw new DomainError("forbidden", "Choose a company before connecting: this account belongs to more than one.", {
      reason: "company_selection_required",
    });
  }
  const organizationId = orgs[0]!;
  const revoked = conns.find((r) => r.organization_id === organizationId && r.status === "revoked");
  if (revoked && !authAfter(revoked.revoked_at)) {
    throw oauthRefused("This connection was revoked. Reconnect Cerebro.", "revoked");
  }

  const ctx: RequestContext = { userId, organizationId, via: "mcp", requestId: randomUUID() };
  let connectionId: string;
  try {
    connectionId = await withCtx(db, ctx, async (tx, cx) => {
      await requireMember(tx, cx);
      const row = (
        await tx.execute<{ id: string }>(sql`
          insert into integration_connections
            (organization_id, user_id, kind, label, client_id, issuer, scopes, status, not_before)
          values (${organizationId}::uuid, ${userId}::uuid, 'oauth', ${`OAuth client ${c.clientId}`.slice(0, 100)},
                  ${c.clientId}, ${c.issuer}, ${JSON.stringify([...c.scopes].sort())}::jsonb, 'active',
                  ${revoked ? toDate(revoked.revoked_at).toISOString() : null}::timestamptz)
          returning id`)
      ).rows[0]!;
      await recordAudit(tx, cx, {
        action: "connection.created",
        targetType: "integration_connection",
        targetId: row.id,
        metadata: { kind: "oauth", clientId: c.clientId },
      });
      return row.id;
    });
  } catch (err) {
    // A concurrent first request created the grant; use it.
    if (!isUniqueViolation(err)) throw err;
    return authenticateOAuthGrant(db, claims);
  }
  return touchConnection(db, userId, organizationId, connectionId, c.scopes);
}
