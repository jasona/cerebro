/**
 * Connection tokens: the dev/test stand-in for delegated MCP authorization
 * (D08). Production uses OAuth account linking and must not accept these.
 * Tokens look like `cbr_<base62>` (32 random bytes), are shown once, and are
 * stored only as a SHA-256 hash plus a short non-secret prefix.
 */
import { randomUUID } from "node:crypto";
import { withAuthContext, withSystemContext, type Database, type Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { parseInput, randomBase62, requireMember, sha256Hex, toDate, toDateOrNull, Uuid, withCtx } from "../org/shared";

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

  const ctx: RequestContext = {
    userId: found.user_id,
    organizationId: found.organization_id,
    via: "mcp",
    connectionId: found.id,
    requestId: randomUUID(),
  };
  // Re-check and touch under the runtime role so the result reflects RLS too.
  await withAuthContext(db, { userId: ctx.userId, organizationId: ctx.organizationId, connectionId: ctx.connectionId }, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      update integration_connections set last_used_at = now()
      where organization_id = ${ctx.organizationId}::uuid and id = ${found.id}::uuid
        and status = 'active' and revoked_at is null
      returning id`);
    if (!res.rows[0]) throw unauthenticated();
  });
  return ctx;
}
