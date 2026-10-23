import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { eq, like, asc } from "drizzle-orm";
import { getDatabase, users, withSystemContext } from "@cerebro/database";
import { authMode } from "./env";
import { decodeSession, SESSION_COOKIE } from "./session-token";

export interface SessionUser {
  userId: string;
  name: string;
  email: string;
  authSubject: string;
}

/**
 * Narrow identity lookup: auth subject -> user row.
 *
 * withSystemContext justification: this runs before any RequestContext exists
 * (we are resolving *who* the caller is), the users RLS policy only exposes
 * users who share a company with `app.user_id`, and the query returns only the
 * caller's own identity fields for an already-verified subject. This is one of
 * the identity lookups the database package permits.
 */
async function findUserBySubject(authSubject: string): Promise<SessionUser | null> {
  const { db } = await getDatabase();
  const rows = await withSystemContext(db, (tx) =>
    tx
      .select({ id: users.id, name: users.displayName, email: users.email, authSubject: users.authSubject })
      .from(users)
      .where(eq(users.authSubject, authSubject))
      .limit(1),
  );
  const row = rows[0];
  return row ? { userId: row.id, name: row.name, email: row.email, authSubject: row.authSubject } : null;
}

async function resolveSubject(): Promise<string | null> {
  if (authMode() === "dev") {
    const jar = await cookies();
    return decodeSession(jar.get(SESSION_COOKIE)?.value)?.sub ?? null;
  }
  // Clerk adapter (stub, D08): Clerk authenticates, Cerebro authorizes.
  // Requires clerkMiddleware in proxy.ts, which only runs when AUTH_MODE=clerk.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  return userId ? `clerk|${userId}` : null;
}

/** The signed-in Cerebro user, or null. Memoised per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const subject = await resolveSubject();
  if (!subject) return null;
  // Clerk users without a provisioned `users` row resolve to null; account
  // provisioning on first Clerk sign-in is not implemented yet.
  return findUserBySubject(subject);
});

/** Only allow same-origin relative paths as post-sign-in destinations. */
export function safeNextPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

export function signInPath(next?: string): string {
  const n = next ? safeNextPath(next, "") : "";
  return n ? `/sign-in?next=${encodeURIComponent(n)}` : "/sign-in";
}

/** The signed-in user; redirects to sign-in (returning to `next`) when absent. */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(signInPath(next));
  return user;
}

export interface DevUserOption {
  authSubject: string;
  name: string;
  email: string;
}

/**
 * Dev sign-in picker: every `dev|*` identity. Callers must check
 * `authMode() === "dev"` first (the page and action both do).
 *
 * withSystemContext justification: identity lookup before sign-in for the
 * dev-only adapter; returns only subject, name and email of seeded dev users.
 */
export async function listDevUsers(): Promise<DevUserOption[]> {
  if (authMode() !== "dev") return [];
  const { db } = await getDatabase();
  const rows = await withSystemContext(db, (tx) =>
    tx
      .select({ authSubject: users.authSubject, name: users.displayName, email: users.email })
      .from(users)
      .where(like(users.authSubject, "dev|%"))
      .orderBy(asc(users.displayName)),
  );
  return rows;
}

export async function devSubjectExists(authSubject: string): Promise<boolean> {
  if (authMode() !== "dev" || !authSubject.startsWith("dev|")) return false;
  return (await findUserBySubject(authSubject)) !== null;
}
