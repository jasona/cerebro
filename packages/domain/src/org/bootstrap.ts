/**
 * Operator bootstrap of a company and its first owner (`npm run org:bootstrap`).
 *
 * In production nobody joins a company by signing in: Clerk's first sign-in
 * either accepts a pending invitation or claims an unlinked, pre-provisioned
 * user with the same verified email (`resolveWebIdentity`). The first owner of
 * a new deployment has no one to invite them, so an operator with database
 * access creates the company and that owner here. The owner then signs in
 * with Clerk using that email, which links the identity, and invites everyone
 * else from the app.
 *
 * Idempotent and deliberately narrow:
 * - company missing: create it, reuse or create the user by email, and make
 *   them an active owner (audited as `organization.bootstrapped`);
 * - company present and the user is already its active owner: no change;
 * - company present otherwise: refused (`conflict`). This never grants owner
 *   rights in an existing company; membership changes there go through the
 *   app's audited member management.
 *
 * withSystemContext justification: no RequestContext exists yet (there is no
 * company or member to act as), and creating organizations and users is not
 * permitted to the runtime role.
 */
import { withSystemContext, type Database } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "../errors";
import { DisplayName, normalizeEmail, parseInput } from "./shared";

export const BootstrapOrganizationInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lower-case letters, digits and hyphens"),
  name: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().email().max(320),
  /** Display name for a newly created user; defaults to the email's local part. Existing users keep theirs. */
  ownerName: DisplayName.optional(),
});
export type BootstrapOrganizationInput = z.input<typeof BootstrapOrganizationInput>;

export interface BootstrapOrganizationResult {
  status: "created" | "unchanged";
  organizationId: string;
  slug: string;
  userId: string;
  /** Whether the owner's user row was created by this call (false: an existing user was reused). */
  userCreated: boolean;
}

/** `users.auth_subject` for an operator-provisioned user until their first sign-in links an identity. */
export const bootstrapAuthSubject = (email: string) => `bootstrap|${normalizeEmail(email)}`;

export async function bootstrapOrganization(db: Database, input: BootstrapOrganizationInput): Promise<BootstrapOrganizationResult> {
  const v = parseInput(BootstrapOrganizationInput, input);
  const email = normalizeEmail(v.ownerEmail);

  return withSystemContext(db, async (tx) => {
    // Serialize concurrent bootstraps of the same slug.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-bootstrap:${v.slug}`}))`);

    const user = (
      await tx.execute<{ id: string }>(sql`select id from users where lower(email) = ${email} for update`)
    ).rows[0];
    const org = (await tx.execute<{ id: string }>(sql`select id from organizations where slug = ${v.slug}`)).rows[0];

    if (org) {
      const owner = user
        ? (
            await tx.execute<{ ok: number }>(sql`
              select 1 as ok from memberships
              where organization_id = ${org.id}::uuid and user_id = ${user.id}::uuid
                and role = 'owner' and status = 'active'`)
          ).rows[0]
        : undefined;
      if (!user || !owner) {
        throw new DomainError(
          "conflict",
          `Company "${v.slug}" already exists and ${email} is not its active owner. Manage its members in the app.`,
        );
      }
      return { status: "unchanged", organizationId: org.id, slug: v.slug, userId: user.id, userCreated: false };
    }

    let userId = user?.id;
    const userCreated = !userId;
    if (!userId) {
      const displayName = v.ownerName ?? (email.split("@")[0] || email).slice(0, 120);
      userId = (
        await tx.execute<{ id: string }>(sql`
          insert into users (auth_subject, email, display_name)
          values (${bootstrapAuthSubject(email)}, ${email}, ${displayName})
          returning id`)
      ).rows[0]!.id;
    }
    const organizationId = (
      await tx.execute<{ id: string }>(sql`
        insert into organizations (slug, name) values (${v.slug}, ${v.name}) returning id`)
    ).rows[0]!.id;
    await tx.execute(sql`
      insert into memberships (organization_id, user_id, role, status)
      values (${organizationId}::uuid, ${userId}::uuid, 'owner', 'active')`);
    await tx.execute(sql`
      insert into audit_events (organization_id, actor_id, action, target_type, target_id, metadata)
      values (${organizationId}::uuid, ${userId}::uuid, 'organization.bootstrapped', 'organization', ${organizationId}::uuid,
        ${JSON.stringify({ via: "cli", userCreated })}::jsonb)`);
    return { status: "created", organizationId, slug: v.slug, userId, userCreated };
  });
}
