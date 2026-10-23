/**
 * Test fixtures for the org, library and integration tests. Briefings are
 * inserted directly in system context so these tests do not depend on the
 * briefings/publication modules.
 */
import { randomUUID } from "node:crypto";
import {
  briefingDrafts,
  briefingGrants,
  briefingRevisions,
  briefings,
  publications,
  withSystemContext,
  type GrantRole,
  type SeedUserKey,
  type Visibility,
} from "@cerebro/database";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { isDomainError } from "../errors";
import type { TestWorld } from "../testing";

export interface FixtureBriefing {
  owner?: SeedUserKey;
  title?: string;
  headline?: string;
  summary?: string;
  visibility?: Visibility;
  audienceDepartment?: string;
  audienceTeam?: string;
  homeDepartment?: string;
  homeTeam?: string;
  /** Published revisions (0 = never published). */
  revisions?: number;
  draft?: boolean;
  draftTitle?: string;
  archived?: boolean;
  withdrawn?: boolean;
  publishedAt?: Date;
}

export async function makeBriefing(w: TestWorld, spec: FixtureBriefing = {}) {
  const acme = w.seed.orgs.acme;
  const organizationId = acme.id;
  const ownerId = w.seed.users[spec.owner ?? "maya"];
  const title = spec.title ?? `Brief ${randomUUID().slice(0, 8)}`;
  const homeDepartmentId = spec.homeTeam
    ? await teamDepartment(w, acme.teams[spec.homeTeam]!)
    : spec.homeDepartment
      ? acme.departments[spec.homeDepartment]!
      : null;
  return withSystemContext(w.h.db, async (tx) => {
    const [b] = await tx
      .insert(briefings)
      .values({
        organizationId,
        ownerId,
        title: spec.draftTitle ?? title,
        slug: `b-${randomUUID()}`,
        visibility: spec.visibility ?? "company",
        audienceDepartmentId: spec.audienceDepartment ? acme.departments[spec.audienceDepartment] : null,
        audienceTeamId: spec.audienceTeam ? acme.teams[spec.audienceTeam] : null,
        homeDepartmentId,
        homeTeamId: spec.homeTeam ? acme.teams[spec.homeTeam] : null,
        archivedAt: spec.archived ? new Date() : null,
      })
      .returning();
    const revisionIds: string[] = [];
    let current: string | null = null;
    for (let n = 1; n <= (spec.revisions ?? 1); n++) {
      const [r] = await tx
        .insert(briefingRevisions)
        .values({
          organizationId,
          briefingId: b!.id,
          number: n,
          documentJson: {
            schemaVersion: 1,
            title,
            position: { headline: spec.headline ?? `${title} headline`, summary: spec.summary ?? `${title} summary text.` },
          },
          schemaVersion: 1,
          contentHash: `h${n}`,
          createdBy: ownerId,
        })
        .returning();
      const [p] = await tx
        .insert(publications)
        .values({
          organizationId,
          briefingId: b!.id,
          revisionId: r!.id,
          publishedBy: ownerId,
          publishedAt: spec.publishedAt ? new Date(spec.publishedAt.getTime() + n) : new Date(Date.now() + n),
          withdrawnAt: spec.withdrawn ? new Date() : null,
        })
        .returning();
      revisionIds.push(r!.id);
      current = p!.id;
    }
    if (current) await tx.update(briefings).set({ currentPublicationId: current }).where(eq(briefings.id, b!.id));
    if (spec.draft) {
      await tx.insert(briefingDrafts).values({
        organizationId,
        briefingId: b!.id,
        documentJson: { schemaVersion: 1, title: spec.draftTitle ?? title },
        schemaVersion: 1,
        updatedBy: ownerId,
      });
    }
    return { id: b!.id, slug: b!.slug, title, revisionIds };
  });
}

async function teamDepartment(w: TestWorld, teamId: string): Promise<string> {
  return withSystemContext(w.h.db, async (tx) => {
    const res = await tx.execute<{ department_id: string }>(sql`select department_id from teams where id = ${teamId}::uuid`);
    return res.rows[0]!.department_id;
  });
}

export async function grant(w: TestWorld, briefingId: string, user: SeedUserKey, role: GrantRole = "reader") {
  await withSystemContext(w.h.db, (tx) =>
    tx.insert(briefingGrants).values({
      organizationId: w.seed.orgs.acme.id,
      briefingId,
      userId: w.seed.users[user],
      role,
      issuedBy: w.seed.users.maya,
    }),
  );
}

export async function expectDomainError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected DomainError ${code}`).not.toBeNull();
  if (!isDomainError(err)) throw err;
  expect(err.code).toBe(code);
}
