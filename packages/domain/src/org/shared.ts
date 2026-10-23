/**
 * Helpers shared by the org, library and integration modules. Not part of the
 * public domain API beyond the few re-exports in org/index.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { withAuthContext, type Database, type Tx } from "@cerebro/database";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getMembership, requireCompanyRole, type Membership } from "../access/index";
import { RequestContext } from "../context";
import { DomainError } from "../errors";

export const Uuid = z.string().uuid();

/** Parse input with Zod, mapping failures to DomainError("validation"). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw new DomainError("validation", "Invalid input.", {
      issues: res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return res.data;
}

export function parseCtx(ctx: RequestContext): RequestContext {
  const res = RequestContext.safeParse(ctx);
  if (!res.success) throw new DomainError("unauthenticated", "Invalid request context.");
  return res.data;
}

/** Open an auth-context transaction for `ctx` (validated). */
export function withCtx<T>(db: Database, ctx: RequestContext, fn: (tx: Tx, ctx: RequestContext) => Promise<T>): Promise<T> {
  const c = parseCtx(ctx);
  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, (tx) =>
    fn(tx, c),
  );
}

/**
 * Require an active company membership. Non-members (including external
 * readers, who can see some member rows at the RLS level) get `not_found` so
 * that company structure is never disclosed to them.
 */
export async function requireMember(tx: Tx, ctx: RequestContext): Promise<Membership> {
  const m = await getMembership(tx, ctx);
  if (!m) throw new DomainError("not_found", "Company not found.");
  return m;
}

/** Company owner or admin; non-members get `not_found`, members `forbidden`. */
export async function requireAdmin(tx: Tx, ctx: RequestContext): Promise<Membership> {
  await requireMember(tx, ctx);
  return requireCompanyRole(tx, ctx, ["owner", "admin"]);
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Base62 encoding of `bytes` random bytes (32 bytes → ~43 chars). */
export function randomBase62(bytes = 32): string {
  let n = BigInt(`0x${randomBytes(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)]! + out;
    n /= 62n;
  }
  const minLen = Math.ceil((bytes * 8) / Math.log2(62));
  return out.padStart(minLen, "0");
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "untitled";
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Escape LIKE wildcards; use with `ilike ... escape '\'`. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `(uuid1, uuid2, ...)` list for `in` clauses; never empty. */
export function uuidList(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`(null::uuid)`;
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
export const toDateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : toDate(v));

export const DisplayName = z.string().trim().min(1).max(120);

/** True when a (possibly driver-wrapped) Postgres error is a unique violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}
