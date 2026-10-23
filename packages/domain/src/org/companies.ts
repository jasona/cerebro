import { withAuthContext, withSystemContext, type Database } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getMembership, type CompanyRole, type Membership } from "../access/index";
import { DomainError } from "../errors";
import { parseInput, Uuid } from "./shared";

export interface CompanyDTO {
  id: string;
  slug: string;
  name: string;
}

export interface MyCompany extends CompanyDTO {
  role: CompanyRole;
  membershipId: string;
}

/** Companies where the user holds an active membership (company switcher). */
export async function listMyCompanies(db: Database, userId: string): Promise<MyCompany[]> {
  const uid = parseInput(Uuid, userId);
  // Cross-company read of the user's own memberships: RLS `memberships_self_read`
  // and `organizations_read` permit exactly this with a null org context.
  return withAuthContext(db, { userId: uid, organizationId: null }, async (tx) => {
    const res = await tx.execute<{ id: string; slug: string; name: string; role: CompanyRole; membership_id: string }>(sql`
      select o.id, o.slug, o.name, m.role, m.id as membership_id
      from memberships m
      join organizations o on o.id = m.organization_id
      where m.user_id = ${uid}::uuid and m.status = 'active'
      order by lower(o.name), o.id`);
    return res.rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role, membershipId: r.membership_id }));
  });
}

const GetCompanyInput = z.object({
  userId: Uuid,
  slug: z.string().trim().min(1).max(100),
  briefingSlug: z.string().trim().min(1).max(200).optional(),
});

export interface CompanyResolution {
  org: CompanyDTO;
  /** Null for an external reader admitted only through a briefing grant. */
  membership: Membership | null;
}

/**
 * Resolve a company from its URL slug for the signed-in user.
 *
 * Members get their active membership. A non-member gets `{ org, membership: null }`
 * only when resolving a specific briefing (`opts.briefingSlug`) on which they
 * hold an active grant; external readers never browse the company. Anything
 * else is `not_found`.
 */
export async function getCompanyBySlug(
  db: Database,
  userId: string,
  slug: string,
  opts: { briefingSlug?: string } = {},
): Promise<CompanyResolution> {
  const input = parseInput(GetCompanyInput, { userId, slug, ...opts });
  // System context: narrow tenant resolution of a public URL slug to an id,
  // needed before an org-scoped auth context can be opened. Returns only id.
  const orgId = await withSystemContext(db, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`select id from organizations where slug = ${input.slug}`);
    return res.rows[0]?.id ?? null;
  });
  if (!orgId) throw new DomainError("not_found", "Company not found.");

  return withAuthContext(db, { userId: input.userId, organizationId: orgId }, async (tx) => {
    const ctx = { userId: input.userId, organizationId: orgId, via: "web" as const, requestId: "company-resolution" };
    const org = (
      await tx.execute<{ id: string; slug: string; name: string }>(
        sql`select id, slug, name from organizations where id = ${orgId}::uuid`,
      )
    ).rows[0];
    if (!org) throw new DomainError("not_found", "Company not found.");
    const membership = await getMembership(tx, ctx);
    if (membership) return { org, membership };
    if (!input.briefingSlug) throw new DomainError("not_found", "Company not found.");
    const grant = await tx.execute<{ ok: number }>(sql`
      select 1 as ok from briefing_grants g
      join briefings b on b.organization_id = g.organization_id and b.id = g.briefing_id
      where g.organization_id = ${orgId}::uuid
        and g.user_id = ${input.userId}::uuid
        and g.revoked_at is null
        and g.role = 'reader'
        and b.slug = ${input.briefingSlug}
        and b.archived_at is null
      limit 1`);
    if (!grant.rows[0]) throw new DomainError("not_found", "Company not found.");
    return { org, membership: null };
  });
}
