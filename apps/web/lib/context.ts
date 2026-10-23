import "server-only";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDatabase, type Database } from "@cerebro/database";
import { getCompanyBySlug, isDomainError, type CompanyDTO, type Membership, type RequestContext } from "@cerebro/domain";
import { requireUser, type SessionUser } from "./auth";
import { loadOrThrow } from "./errors";

/** The process-wide Drizzle database (PGlite singleton or Postgres pool). */
export async function getDb(): Promise<Database> {
  return (await getDatabase()).db;
}

export interface WorkspaceContext {
  db: Database;
  user: SessionUser;
  org: CompanyDTO;
  membership: Membership;
  ctx: RequestContext;
  /** Owner or admin: may see the Admin entry. Content access is unaffected (D09). */
  isAdmin: boolean;
}

export interface BriefingRouteContext {
  db: Database;
  user: SessionUser;
  org: CompanyDTO;
  /** Null for an external reader admitted only via a briefing grant. */
  membership: Membership | null;
  ctx: RequestContext;
  isMember: boolean;
}

function makeCtx(userId: string, organizationId: string): RequestContext {
  return { userId, organizationId, via: "web", requestId: randomUUID() };
}

/** One membership resolution per request, shared by layout and page. */
const resolveCompany = cache(async (companySlug: string) => {
  const user = await requireUser(`/c/${encodeURIComponent(companySlug)}`);
  const db = await getDb();
  try {
    const res = await getCompanyBySlug(db, user.userId, companySlug);
    return { db, user, res };
  } catch (err) {
    if (isDomainError(err) && (err.code === "not_found" || err.code === "validation")) return { db, user, res: null };
    throw err;
  }
});

/**
 * Workspace routes (`/c/[company]/**` except briefing pages): signed-in user
 * with an active membership. Non-members, unknown slugs and other tenants all
 * get notFound(), so company existence is not disclosed. Memoised per request.
 */
export const getRequestContext = cache(async (companySlug: string): Promise<WorkspaceContext> => {
  const { db, user, res } = await resolveCompany(companySlug);
  if (!res?.membership) notFound();
  return {
    db,
    user,
    org: res.org,
    membership: res.membership,
    ctx: makeCtx(user.userId, res.org.id),
    isAdmin: res.membership.role === "owner" || res.membership.role === "admin",
  };
});

/**
 * Like getRequestContext but returns null for non-members instead of 404.
 * The company layout uses it to choose workspace chrome vs minimal chrome
 * (external readers on a briefing route). Pages must still call
 * getRequestContext or getBriefingRequestContext.
 */
export const getOptionalWorkspaceContext = cache(async (companySlug: string): Promise<WorkspaceContext | null> => {
  const { res } = await resolveCompany(companySlug);
  if (!res?.membership) return null;
  return getRequestContext(companySlug);
});

/**
 * Briefing routes (`/c/[company]/b/[briefing]/**`): members, plus external
 * readers who hold an active reader grant on that briefing (D04). The org is
 * resolved without membership for grant holders; the briefing domain services
 * still authorize every read. External readers must not be shown workspace
 * navigation or the directory: check `isMember` before rendering any.
 */
export const getBriefingRequestContext = cache(
  async (companySlug: string, briefingSlug: string): Promise<BriefingRouteContext> => {
    const user = await requireUser(`/c/${encodeURIComponent(companySlug)}/b/${encodeURIComponent(briefingSlug)}`);
    const db = await getDb();
    const res = await loadOrThrow(() => getCompanyBySlug(db, user.userId, companySlug, { briefingSlug }));
    return {
      db,
      user,
      org: res.org,
      membership: res.membership,
      ctx: makeCtx(user.userId, res.org.id),
      isMember: res.membership !== null,
    };
  },
);

