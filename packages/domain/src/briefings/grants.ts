/**
 * Briefing grants (reader / editor / publisher, optional revision scope).
 * manage_access only (briefing owner in the MVP); every change is audited.
 */
import {
  briefingGrants,
  briefingRevisions,
  memberships,
  users,
  withSystemContext,
  type Database,
  type Tx,
} from "@cerebro/database";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import { inAuthTx, loadBriefingRow, parseInput, pgCode, userRefs, type UserRef } from "./shared";

export const GRANTABLE_ROLES = ["reader", "editor", "publisher"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export interface GrantDTO {
  grantId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: GrantableRole | "owner";
  /** Revision scope, when the grant covers one revision only. */
  revisionNumber: number | null;
  issuedBy: string;
  createdAt: Date;
  /** True when the grantee has no active company membership (external reader). */
  external: boolean;
}

export interface AccessListDTO {
  briefingId: string;
  owner: UserRef;
  grants: GrantDTO[];
}

export const GrantAccessInput = z
  .object({
    briefingId: z.string().uuid(),
    userId: z.string().uuid().optional(),
    email: z.string().email().max(320).optional(),
    role: z.enum(GRANTABLE_ROLES),
    /** Scope a reader grant to one published revision. */
    revisionNumber: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.userId === undefined) !== (v.email === undefined), { message: "Provide userId or email." })
  .refine((v) => v.revisionNumber === undefined || v.role === "reader", {
    message: "Only reader grants can be scoped to a revision.",
    path: ["revisionNumber"],
  });
export type GrantAccessInput = z.input<typeof GrantAccessInput>;

export const RevokeGrantInput = z.object({ briefingId: z.string().uuid(), grantId: z.string().uuid() }).strict();
export type RevokeGrantInput = z.input<typeof RevokeGrantInput>;

export async function listAccessInTx(tx: Tx, ctx: RequestContext, briefingId: string): Promise<AccessListDTO> {
  const id = parseInput(z.string().uuid(), briefingId);
  await assertBriefingCapability(tx, ctx, id, "manage_access");
  const b = (await loadBriefingRow(tx, ctx, id))!;
  const rows = await tx
    .select({
      grantId: briefingGrants.id,
      userId: briefingGrants.userId,
      displayName: users.displayName,
      email: users.email,
      role: briefingGrants.role,
      revisionNumber: briefingRevisions.number,
      issuedBy: briefingGrants.issuedBy,
      createdAt: briefingGrants.createdAt,
      isMember: sql<boolean>`exists (select 1 from memberships m where m.organization_id = ${briefingGrants.organizationId}
                              and m.user_id = ${briefingGrants.userId} and m.status = 'active')`,
    })
    .from(briefingGrants)
    .leftJoin(users, eq(users.id, briefingGrants.userId))
    .leftJoin(
      briefingRevisions,
      and(eq(briefingRevisions.organizationId, briefingGrants.organizationId), eq(briefingRevisions.id, briefingGrants.revisionId)),
    )
    .where(
      and(eq(briefingGrants.organizationId, ctx.organizationId), eq(briefingGrants.briefingId, id), isNull(briefingGrants.revokedAt)),
    )
    .orderBy(asc(briefingGrants.createdAt));
  const [owner] = await userRefs(tx, [b.ownerId]);
  return {
    briefingId: id,
    owner: owner!,
    grants: rows.map((r) => ({
      grantId: r.grantId,
      userId: r.userId,
      displayName: r.displayName ?? "Unknown user",
      email: r.email ?? null,
      role: r.role as GrantDTO["role"],
      revisionNumber: r.revisionNumber ?? null,
      issuedBy: r.issuedBy,
      createdAt: r.createdAt,
      external: !r.isMember,
    })),
  };
}

export function listAccess(db: Database, ctx: RequestContext, briefingId: string): Promise<AccessListDTO> {
  return inAuthTx(db, ctx, (tx, c) => listAccessInTx(tx, c, briefingId));
}

/**
 * Grant a role. Editor/publisher grantees must be active company members.
 * Re-granting an identical active grant returns the existing one. In the
 * transaction-composable variant the grantee must be given by `userId`.
 */
export async function grantAccessInTx(tx: Tx, ctx: RequestContext, rawInput: GrantAccessInput): Promise<GrantDTO> {
  const input = parseInput(GrantAccessInput, rawInput);
  if (!input.userId) throw new DomainError("validation", "grantAccessInTx requires userId.");
  const userId = input.userId;
  await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");

  if (input.role !== "reader") {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.userId, userId), eq(memberships.status, "active")));
    if (!m) throw new DomainError("validation", "Editors and publishers must be active company members.", { field: "userId" });
  }

  let revisionId: string | null = null;
  if (input.revisionNumber !== undefined) {
    const [r] = await tx
      .select({ id: briefingRevisions.id })
      .from(briefingRevisions)
      .where(
        and(
          eq(briefingRevisions.organizationId, ctx.organizationId),
          eq(briefingRevisions.briefingId, input.briefingId),
          eq(briefingRevisions.number, input.revisionNumber),
        ),
      );
    if (!r) throw new DomainError("validation", "Unknown revision.", { field: "revisionNumber" });
    revisionId = r.id;
  }

  const [existing] = await tx
    .select({ id: briefingGrants.id })
    .from(briefingGrants)
    .where(
      and(
        eq(briefingGrants.organizationId, ctx.organizationId),
        eq(briefingGrants.briefingId, input.briefingId),
        eq(briefingGrants.userId, userId),
        eq(briefingGrants.role, input.role),
        revisionId ? eq(briefingGrants.revisionId, revisionId) : isNull(briefingGrants.revisionId),
        isNull(briefingGrants.revokedAt),
      ),
    );
  let grantId = existing?.id;
  if (!grantId) {
    try {
      const [g] = await tx.transaction((sp) =>
        sp
          .insert(briefingGrants)
          .values({
            organizationId: ctx.organizationId,
            briefingId: input.briefingId,
            userId,
            role: input.role,
            revisionId,
            issuedBy: ctx.userId,
          })
          .returning({ id: briefingGrants.id }),
      );
      grantId = g!.id;
    } catch (e) {
      if (pgCode(e) === "23503") throw new DomainError("not_found", "User not found.", { field: "userId" });
      throw e;
    }
    await recordAudit(tx, ctx, {
      action: "grant.created",
      targetType: "briefing",
      targetId: input.briefingId,
      revisionId,
      metadata: { grantId, granteeId: userId, role: input.role },
    });
  }
  const list = await listAccessInTx(tx, ctx, input.briefingId);
  const dto = list.grants.find((g) => g.grantId === grantId);
  if (!dto) throw new DomainError("unavailable", "Grant was not visible after creation.");
  return dto;
}

/**
 * Grant by userId or email. Email resolution uses the system context: users
 * outside the company are hidden by RLS, and an external reader must be
 * addressable by email. It runs only after manage_access is confirmed and
 * returns nothing but the user id (narrow identity lookup).
 */
export async function grantAccess(db: Database, ctx: RequestContext, rawInput: GrantAccessInput): Promise<GrantDTO> {
  const input = parseInput(GrantAccessInput, rawInput);
  let userId = input.userId;
  if (!userId) {
    await inAuthTx(db, ctx, (tx, c) => assertBriefingCapability(tx, c, input.briefingId, "manage_access"));
    const email = input.email!.trim().toLowerCase();
    userId = await withSystemContext(db, async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      return u?.id;
    });
    if (!userId) throw new DomainError("not_found", "No user with that email. Send an invitation instead.");
  }
  const { email: _email, ...rest } = input;
  return inAuthTx(db, ctx, (tx, c) => grantAccessInTx(tx, c, { ...rest, userId }));
}

export async function revokeGrantInTx(tx: Tx, ctx: RequestContext, rawInput: RevokeGrantInput): Promise<{ grantId: string; revoked: boolean }> {
  const input = parseInput(RevokeGrantInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");
  const rows = await tx
    .update(briefingGrants)
    .set({ revokedAt: sql`now()`, revokedBy: ctx.userId })
    .where(
      and(
        eq(briefingGrants.organizationId, ctx.organizationId),
        eq(briefingGrants.briefingId, input.briefingId),
        eq(briefingGrants.id, input.grantId),
        isNull(briefingGrants.revokedAt),
      ),
    )
    .returning({ id: briefingGrants.id, userId: briefingGrants.userId, role: briefingGrants.role, revisionId: briefingGrants.revisionId });
  const r = rows[0];
  if (!r) {
    const [g] = await tx
      .select({ id: briefingGrants.id })
      .from(briefingGrants)
      .where(and(eq(briefingGrants.briefingId, input.briefingId), eq(briefingGrants.id, input.grantId)));
    if (!g) throw new DomainError("not_found", "Grant not found.");
    return { grantId: input.grantId, revoked: false };
  }
  await recordAudit(tx, ctx, {
    action: "grant.revoked",
    targetType: "briefing",
    targetId: input.briefingId,
    revisionId: r.revisionId,
    metadata: { grantId: r.id, granteeId: r.userId, role: r.role },
  });
  return { grantId: r.id, revoked: true };
}

export function revokeGrant(db: Database, ctx: RequestContext, input: RevokeGrantInput): Promise<{ grantId: string; revoked: boolean }> {
  return inAuthTx(db, ctx, (tx, c) => revokeGrantInTx(tx, c, input));
}
