import "server-only";
import { notFound } from "next/navigation";
import {
  getBriefingMeta,
  getRevisionDocument,
  isDomainError,
  type BriefingMetaDTO,
  type Capability,
  type RevisionDocumentDTO,
} from "@cerebro/domain";
import type { Crumb } from "@/components/workspace/shell-context";
import { getBriefingRequestContext, type BriefingRouteContext } from "@/lib/context";
import { handlePageError } from "@/lib/errors";
import { paths } from "@/lib/paths";

export interface BriefingPageParams {
  company: string;
  briefing: string;
}

/** Decoded route params (Next passes them URL-encoded for non-ASCII). */
export async function readParams(params: Promise<BriefingPageParams>): Promise<BriefingPageParams> {
  const p = await params;
  return { company: decodeURIComponent(p.company), briefing: decodeURIComponent(p.briefing) };
}

/**
 * Briefing metadata (home, audience, owner, capabilities, draft pointer), or
 * null when the viewer may not read it. `withdrawn` is true only for viewers
 * the domain allows to learn that (details.reason === "withdrawn").
 */
export async function loadMeta(rc: BriefingRouteContext, slug: string): Promise<{ meta: BriefingMetaDTO | null; withdrawn: boolean }> {
  try {
    return { meta: await getBriefingMeta(rc.db, rc.ctx, { slug }), withdrawn: false };
  } catch (err) {
    if (isDomainError(err) && err.code === "not_found") {
      return { meta: null, withdrawn: (err.details as { reason?: string } | undefined)?.reason === "withdrawn" };
    }
    throw err;
  }
}

export type RevisionLoad =
  | { kind: "ok"; rev: RevisionDocumentDTO }
  | { kind: "withdrawn" }
  | { kind: "not_found" };

export async function loadRevision(rc: BriefingRouteContext, slug: string, revisionNumber?: number): Promise<RevisionLoad> {
  try {
    return { kind: "ok", rev: await getRevisionDocument(rc.db, rc.ctx, { slug, ...(revisionNumber ? { revisionNumber } : {}) }) };
  } catch (err) {
    if (isDomainError(err) && err.code === "not_found") {
      return (err.details as { reason?: string } | undefined)?.reason === "withdrawn" ? { kind: "withdrawn" } : { kind: "not_found" };
    }
    throw err;
  }
}

/**
 * Author views (edit, preview, history, engagement, access): resolve context
 * and metadata, and 404 unless the viewer holds `capability`. The domain
 * re-checks on every call; this only avoids rendering an unusable page.
 */
export async function requireAuthorView(
  params: Promise<BriefingPageParams>,
  capability: Capability,
): Promise<{ rc: BriefingRouteContext; meta: BriefingMetaDTO; company: string; briefing: string }> {
  const { company, briefing } = await readParams(params);
  const rc = await getBriefingRequestContext(company, briefing);
  let meta: BriefingMetaDTO;
  try {
    meta = await getBriefingMeta(rc.db, rc.ctx, { slug: briefing });
  } catch (err) {
    handlePageError(err);
  }
  if (!meta.capabilities.includes(capability)) notFound();
  return { rc, meta, company: rc.org.slug, briefing: meta.slug };
}

/** Company / Department / Team / Title (+ optional trailing page) for the shell breadcrumb. Members only. */
export function briefingCrumbs(company: { slug: string; name: string }, meta: BriefingMetaDTO, trailing?: string): Crumb[] {
  const c = company.slug;
  const crumbs: Crumb[] = [{ label: company.name, href: paths.company(c) }];
  if (meta.home.department) crumbs.push({ label: meta.home.department.name, href: paths.department(c, meta.home.department.slug) });
  if (meta.home.department && meta.home.team) {
    crumbs.push({ label: meta.home.team.name, href: paths.team(c, meta.home.department.slug, meta.home.team.slug) });
  }
  crumbs.push(trailing ? { label: meta.title, href: paths.briefing(c, meta.slug) } : { label: meta.title });
  if (trailing) crumbs.push({ label: trailing });
  return crumbs;
}

/** Parse a positive integer route/query value, or null. */
export function positiveInt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

export const firstParam = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
