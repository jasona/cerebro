import "server-only";
import type { Database } from "@cerebro/database";
import { createLogger, findUserByIdentity, resolveWebIdentity, type IdentityUser, type WebIdentityResult } from "@cerebro/domain";

/**
 * Clerk web identity (D08, AUTH_MODE=clerk). Clerk authenticates; Cerebro
 * maps the verified Clerk user to a Cerebro user through an explicit identity
 * link (issuer = the session token's `iss`, subject = the Clerk user id) and
 * keeps all authorization in the domain services.
 *
 * First sign-in is handled by `resolveWebIdentity`: a user row is created only
 * when the verified email has a pending invitation (accepted explicitly
 * afterwards), or an unlinked pre-provisioned user with that verified email
 * is claimed. Nobody joins a company by signing in.
 *
 * `@clerk/nextjs/server` is imported lazily so dev mode never loads Clerk.
 */

export type ClerkSignInReason =
  | "signed_out"
  | "missing_issuer"
  | "no_email"
  | Exclude<WebIdentityResult["status"], "linked" | "claimed" | "provisioned">;

export type ClerkSessionState = { user: IdentityUser; reason?: undefined } | { user: null; reason: ClerkSignInReason };

interface ClerkEmail {
  id: string;
  emailAddress: string;
  verification: { status: string } | null;
}

interface ClerkProfile {
  firstName: string | null;
  lastName: string | null;
  fullName?: string | null;
  username: string | null;
  primaryEmailAddressId: string | null;
  emailAddresses: ClerkEmail[];
}

function displayNameOf(profile: ClerkProfile, email: string): string {
  const full = profile.fullName ?? [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  return (full.trim() || profile.username?.trim() || email.split("@")[0] || email).slice(0, 120);
}

const logger = createLogger({ component: "clerk-identity" });
let issuerChecked = false;

/**
 * MCP OAuth through Clerk (D13) finds users by the same identity link: the
 * access token's `iss` must equal this session's `iss` (Clerk's Frontend API
 * URL). A different CEREBRO_OAUTH_ISSUER would refuse every MCP connection
 * as "not linked", so say so once in the log. Both values are public URLs.
 */
function warnOnIssuerMismatch(sessionIssuer: string): void {
  if (issuerChecked) return;
  issuerChecked = true;
  const oauthIssuer = process.env.CEREBRO_OAUTH_ISSUER?.trim();
  if (oauthIssuer && oauthIssuer !== sessionIssuer && (process.env.CEREBRO_OAUTH_PROFILE?.trim().toLowerCase() || "clerk") === "clerk") {
    logger.warn("oauth.issuer_mismatch", { sessionIssuer, oauthIssuer });
  }
}

/** Resolve the current Clerk session to a Cerebro user (provisioning on first sign-in per the rules above). */
export async function resolveClerkSession(db: Database): Promise<ClerkSessionState> {
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const session = await auth();
  if (!session.userId) return { user: null, reason: "signed_out" };
  const iss = session.sessionClaims?.iss;
  if (typeof iss !== "string" || !iss) return { user: null, reason: "missing_issuer" };
  const key = { issuer: iss, subject: session.userId };
  warnOnIssuerMismatch(iss);

  const linked = await findUserByIdentity(db, key);
  if (linked) return { user: linked };

  // First sign-in only: fetch the verified profile from Clerk.
  const profile = (await currentUser()) as ClerkProfile | null;
  const primary = profile?.emailAddresses.find((e) => e.id === profile.primaryEmailAddressId);
  if (!profile || !primary) return { user: null, reason: "no_email" };
  const res = await resolveWebIdentity(db, {
    ...key,
    email: primary.emailAddress,
    emailVerified: primary.verification?.status === "verified",
    displayName: displayNameOf(profile, primary.emailAddress),
    authSubject: `clerk|${session.userId}`,
  });
  return "user" in res ? { user: res.user } : { user: null, reason: res.status };
}
