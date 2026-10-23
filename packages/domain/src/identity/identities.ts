/**
 * Identity links (D08, migration 0006): the explicit mapping from a verified
 * external identity (issuer + subject) to a Cerebro user.
 *
 * Clerk (production web identity) and the MCP OAuth authorization server only
 * authenticate. Cerebro decides who the subject is here, and every capability
 * is still decided by memberships, grants and the domain services.
 *
 * A first sign-in never joins anyone to a company. It may create a bare
 * `users` row only when the verified email has a pending invitation; the
 * invitation itself is still accepted explicitly through `acceptInvitation`,
 * with its email match and inviter recheck. There is no email-domain
 * auto-join.
 */
import { withSystemContext, type Database, type Tx } from "@cerebro/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DisplayName, isUniqueViolation, normalizeEmail, parseInput } from "../org/shared";

export interface IdentityUser {
  userId: string;
  name: string;
  email: string;
  authSubject: string;
}

export const IdentityKey = z.object({
  issuer: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
});
export type IdentityKey = z.infer<typeof IdentityKey>;

interface UserRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  email: string;
  auth_subject: string;
}

const toUser = (r: UserRow): IdentityUser => ({ userId: r.id, name: r.display_name, email: r.email, authSubject: r.auth_subject });

async function linkedUserInTx(tx: Tx, key: IdentityKey): Promise<IdentityUser | null> {
  const res = await tx.execute<UserRow>(sql`
    select u.id, u.display_name, u.email, u.auth_subject
    from user_identities i join users u on u.id = i.user_id
    where i.issuer = ${key.issuer} and i.subject = ${key.subject}`);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

/**
 * The Cerebro user linked to a verified (issuer, subject), or null.
 *
 * withSystemContext justification: identity lookup before any RequestContext
 * exists (we are resolving who the caller is). The caller has already
 * verified the subject; only the linked user's identity fields are read.
 */
export async function findUserByIdentity(db: Database, key: IdentityKey): Promise<IdentityUser | null> {
  const k = parseInput(IdentityKey, key);
  return withSystemContext(db, (tx) => linkedUserInTx(tx, k));
}

export const WebIdentityInput = IdentityKey.extend({
  /** Primary email as reported by the identity provider. */
  email: z.string().trim().email().max(320),
  /** Whether the identity provider verified that email. Unverified emails never provision or link. */
  emailVerified: z.boolean(),
  displayName: DisplayName,
  /** `users.auth_subject` for a newly created user, e.g. `clerk|user_123`. */
  authSubject: z.string().trim().min(1).max(600),
});
export type WebIdentityInput = z.infer<typeof WebIdentityInput>;

export type WebIdentityResult =
  /** Already linked. */
  | { status: "linked"; user: IdentityUser }
  /** Linked to an existing, never-linked user with the same verified email (operator-provisioned owner). */
  | { status: "claimed"; user: IdentityUser }
  /** New user created because a pending invitation exists for the verified email. */
  | { status: "provisioned"; user: IdentityUser }
  | { status: "email_unverified" }
  /** No account and no pending invitation for this email. */
  | { status: "not_invited" }
  /** A user with this email is already linked to another identity. Never auto-merged. */
  | { status: "identity_conflict" };

/**
 * Resolve a verified web sign-in to a Cerebro user, creating the identity
 * link (and, through a pending invitation only, the user) on first sign-in.
 *
 * withSystemContext justification: identity provisioning happens before any
 * RequestContext exists and needs to read invitations across companies
 * (existence only) and insert into `users` / `user_identities`, which the
 * runtime role cannot write. It reads and writes nothing else.
 */
export async function resolveWebIdentity(db: Database, input: WebIdentityInput): Promise<WebIdentityResult> {
  const v = parseInput(WebIdentityInput, input);
  const attempt = () =>
    withSystemContext(db, async (tx): Promise<WebIdentityResult> => {
      const linked = await linkedUserInTx(tx, v);
      if (linked) return { status: "linked", user: linked };
      if (!v.emailVerified) return { status: "email_unverified" };
      const email = normalizeEmail(v.email);

      const existing = (
        await tx.execute<UserRow & { linked: boolean }>(sql`
          select u.id, u.display_name, u.email, u.auth_subject,
            exists (select 1 from user_identities i where i.user_id = u.id) as linked
          from users u where lower(u.email) = ${email}
          for update`)
      ).rows[0];
      if (existing) {
        if (existing.linked) return { status: "identity_conflict" };
        await tx.execute(sql`
          insert into user_identities (user_id, issuer, subject) values (${existing.id}::uuid, ${v.issuer}, ${v.subject})`);
        return { status: "claimed", user: toUser(existing) };
      }

      const invited = (
        await tx.execute<{ invited: boolean }>(sql`
          select exists (
            select 1 from invitations
            where lower(email) = ${email} and accepted_at is null and revoked_at is null and expires_at > now()
          ) as invited`)
      ).rows[0]?.invited;
      if (!invited) return { status: "not_invited" };

      const created = (
        await tx.execute<UserRow>(sql`
          insert into users (auth_subject, email, display_name)
          values (${v.authSubject}, ${email}, ${v.displayName})
          returning id, display_name, email, auth_subject`)
      ).rows[0]!;
      await tx.execute(sql`
        insert into user_identities (user_id, issuer, subject) values (${created.id}::uuid, ${v.issuer}, ${v.subject})`);
      return { status: "provisioned", user: toUser(created) };
    });
  try {
    return await attempt();
  } catch (err) {
    // A concurrent first sign-in for the same identity won the race: the
    // second attempt sees the link (or the conflict) it created.
    if (isUniqueViolation(err)) return attempt();
    throw err;
  }
}
