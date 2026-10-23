/**
 * Idempotent integration operations (`integration_operations`). A retried
 * mutation with the same key and input returns the recorded result; the same
 * key with different input is an `idempotency_mismatch`. The operation record
 * and the mutation commit atomically in one transaction, so a failed mutation
 * leaves no record and can be retried.
 *
 * Only result references and minimal result JSON are stored, never prompt or
 * document payloads: the input is kept only as a SHA-256 digest.
 */
import { createHash } from "node:crypto";
import type { Database, Tx } from "@cerebro/database";
import { canonicalJson } from "@cerebro/briefing-schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getMembership, resolveBriefingAccess } from "../access/index";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { parseInput, toDate, toDateOrNull, Uuid, withCtx } from "../org/shared";

export interface OperationResultRef {
  /** e.g. "briefing", "publication", "preview". */
  type: string;
  id: string;
}

export type OperationJson = null | boolean | number | string | OperationJson[] | { [key: string]: OperationJson };

export interface OperationOutcome<R extends OperationJson = OperationJson> {
  resultRef: OperationResultRef | null;
  /** Minimal JSON result (ids, versions, statuses). Never prompts or document bodies. */
  result: R;
}

export interface IdempotentResult<R extends OperationJson = OperationJson> extends OperationOutcome<R> {
  operationId: string;
  /** True when the stored result of an earlier identical request was returned. */
  replayed: boolean;
}

export interface OperationDTO {
  id: string;
  action: string;
  status: "pending" | "succeeded" | "failed";
  resultRef: OperationResultRef | null;
  result: OperationJson | null;
  errorCategory: string | null;
  connectionId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const RunInput = z.object({
  action: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_.:-]*$/, "lower-case action name"),
  idempotencyKey: z.string().min(1).max(200),
  input: z.unknown(),
});

/** SHA-256 hex of the canonical JSON of the input (stable across key order). */
export function operationInputDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(input === undefined ? null : input), "utf8")
    .digest("hex");
}

interface OpRow extends Record<string, unknown> {
  id: string;
  action: string;
  status: "pending" | "succeeded" | "failed";
  input_digest: string;
  resource_type: string | null;
  resource_id: string | null;
  result: unknown;
  error_category: string | null;
  connection_id: string | null;
  created_at: unknown;
  completed_at: unknown;
}

const OP_COLS = sql`id, action, status, input_digest, resource_type, resource_id, result, error_category, connection_id,
  created_at, completed_at`;

const refOf = (r: OpRow): OperationResultRef | null =>
  r.resource_type && r.resource_id ? { type: r.resource_type, id: r.resource_id } : null;

async function findOp(tx: Tx, ctx: RequestContext, action: string, key: string): Promise<OpRow | undefined> {
  const res = await tx.execute<OpRow>(sql`
    select ${OP_COLS} from integration_operations
    where organization_id = ${ctx.organizationId}::uuid and actor_id = ${ctx.userId}::uuid
      and connection_id is not distinct from ${ctx.connectionId ?? null}::uuid
      and action = ${action} and idempotency_key = ${key}`);
  return res.rows[0];
}

/**
 * Cached results are re-authorized on every read and replay: a briefing
 * result is returned only while the user still holds some capability on it.
 */
async function reauthorize(tx: Tx, ctx: RequestContext, row: OpRow): Promise<OpRow> {
  if (row.resource_type === "briefing" && row.resource_id) {
    const access = await resolveBriefingAccess(tx, ctx, row.resource_id);
    if (!access || access.capabilities.size === 0) throw new DomainError("not_found", "Operation not found.");
  }
  return row;
}

function replay<R extends OperationJson>(row: OpRow, digest: string): IdempotentResult<R> {
  if (row.input_digest !== digest) {
    throw new DomainError("idempotency_mismatch", "This idempotency key was already used with different input.", {
      operationId: row.id,
    });
  }
  if (row.status !== "succeeded") {
    throw new DomainError("conflict", "An operation with this idempotency key is not complete.", { operationId: row.id, status: row.status });
  }
  return { operationId: row.id, replayed: true, resultRef: refOf(row), result: (row.result ?? null) as R };
}

/**
 * Run `fn` at most once per (company, actor, connection, action, key) inside
 * the caller's transaction. Requires current active membership, including on
 * replay.
 */
export async function runIdempotentInTx<R extends OperationJson>(
  tx: Tx,
  ctx: RequestContext,
  rawInput: { action: string; idempotencyKey: string; input: unknown },
  fn: (tx: Tx) => Promise<OperationOutcome<R>>,
): Promise<IdempotentResult<R>> {
  const { action, idempotencyKey, input } = parseInput(RunInput, rawInput);
  if (!(await getMembership(tx, ctx))) throw new DomainError("forbidden", "Active company membership is required.");
  let digest: string;
  try {
    digest = operationInputDigest(input);
  } catch {
    throw new DomainError("validation", "Operation input must be plain JSON.");
  }

  const existing = await findOp(tx, ctx, action, idempotencyKey);
  if (existing) return replay<R>(await reauthorize(tx, ctx, existing), digest);

  const inserted = (
    await tx.execute<{ id: string }>(sql`
      insert into integration_operations (organization_id, actor_id, connection_id, action, idempotency_key, input_digest, status)
      values (${ctx.organizationId}::uuid, ${ctx.userId}::uuid, ${ctx.connectionId ?? null}::uuid, ${action}, ${idempotencyKey},
              ${digest}, 'pending')
      on conflict do nothing
      returning id`)
  ).rows[0];
  if (!inserted) {
    // A concurrent request with the same key committed first.
    const winner = await findOp(tx, ctx, action, idempotencyKey);
    if (winner) return replay<R>(await reauthorize(tx, ctx, winner), digest);
    throw new DomainError("conflict", "Concurrent operation with the same idempotency key.");
  }

  const outcome = await fn(tx);
  const ref = outcome.resultRef;
  if (ref && (!Uuid.safeParse(ref.id).success || !ref.type || ref.type.length > 100)) {
    throw new Error("runIdempotent: resultRef must be { type, id: uuid }");
  }
  await tx.execute(sql`
    update integration_operations set
      status = 'succeeded', resource_type = ${ref?.type ?? null}, resource_id = ${ref?.id ?? null}::uuid,
      result = ${JSON.stringify(outcome.result ?? null)}::jsonb, completed_at = now(), updated_at = now()
    where organization_id = ${ctx.organizationId}::uuid and id = ${inserted.id}::uuid`);
  return { operationId: inserted.id, replayed: false, resultRef: ref ?? null, result: outcome.result };
}

/** `runIdempotentInTx` in its own auth-context transaction. */
export const runIdempotent = <R extends OperationJson>(
  db: Database,
  ctx: RequestContext,
  input: { action: string; idempotencyKey: string; input: unknown },
  fn: (tx: Tx) => Promise<OperationOutcome<R>>,
): Promise<IdempotentResult<R>> => withCtx(db, ctx, (tx, c) => runIdempotentInTx<R>(tx, c, input, fn));

export async function getOperationInTx(tx: Tx, ctx: RequestContext, operationId: string): Promise<OperationDTO> {
  const id = parseInput(Uuid, operationId);
  const notFound = () => new DomainError("not_found", "Operation not found.");
  if (!(await getMembership(tx, ctx))) throw notFound();
  const row = (
    await tx.execute<OpRow>(sql`
      select ${OP_COLS} from integration_operations
      where organization_id = ${ctx.organizationId}::uuid and id = ${id}::uuid and actor_id = ${ctx.userId}::uuid`)
  ).rows[0];
  if (!row) throw notFound();
  await reauthorize(tx, ctx, row);
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    resultRef: refOf(row),
    result: (row.result ?? null) as OperationJson | null,
    errorCategory: row.error_category,
    connectionId: row.connection_id,
    createdAt: toDate(row.created_at),
    completedAt: toDateOrNull(row.completed_at),
  };
}

/** Status and result of the user's own operation, with current access checks. */
export const getOperation = (db: Database, ctx: RequestContext, operationId: string) =>
  withCtx(db, ctx, (tx, c) => getOperationInTx(tx, c, operationId));
