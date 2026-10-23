import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { findRepoRoot, handleOf, withSystemContext, type Database, type DatabaseHandle, type Tx } from "./client";
import {
  departmentMemberships,
  departments,
  memberships,
  organizations,
  teamMemberships,
  teams,
  users,
  type CompanyRole,
} from "./schema";

// Seed data per IMPLEMENTATION_GUIDE.md "Seed data". Idempotent: rows are
// upserted by natural keys (auth subject, slugs).

const SEED_USERS = {
  riley: { name: "Riley Lee", email: "riley@acme.example" },
  maya: { name: "Maya Chen", email: "maya@acme.example" },
  alex: { name: "Alex Rivera", email: "alex@acme.example" },
  priya: { name: "Priya Shah", email: "priya@acme.example" },
  jordan: { name: "Jordan Ellis", email: "jordan@acme.example" },
  sam: { name: "Sam Taylor", email: "sam@acme.example" },
  casey: { name: "Casey Morgan", email: "casey@partner.example" },
  taylor: { name: "Taylor Kim", email: "taylor@globex.example" },
} as const;

export type SeedUserKey = keyof typeof SEED_USERS;

const SEED_ORGS = {
  acme: {
    name: "Acme",
    departments: {
      product: { name: "Product", teams: { platform: "Platform", experience: "Experience" } },
      engineering: { name: "Engineering", teams: { infrastructure: "Infrastructure", applications: "Applications" } },
      "go-to-market": { name: "Go-to-market", teams: { marketing: "Marketing", sales: "Sales" } },
      finance: { name: "Finance", teams: { planning: "Planning" } },
    },
    members: {
      riley: { role: "owner", departments: [], teams: [] },
      maya: { role: "member", departments: [], teams: ["platform", "experience"] },
      alex: { role: "member", departments: [], teams: ["infrastructure", "platform"] },
      // Explicit Product department member without a Product team: exercises
      // "parent department membership alone does not grant team audiences".
      priya: { role: "member", departments: ["product"], teams: ["planning"] },
      jordan: { role: "member", departments: [], teams: ["marketing", "sales"] },
      sam: { role: "member", departments: [], teams: ["applications"] },
    },
  },
  globex: {
    name: "Globex",
    departments: {
      operations: { name: "Operations", teams: { logistics: "Logistics" } },
    },
    members: {
      taylor: { role: "owner", departments: [], teams: ["logistics"] },
    },
  },
} as const satisfies Record<string, OrgSpec>;

interface OrgSpec {
  name: string;
  departments: Record<string, { name: string; teams: Record<string, string> }>;
  members: Partial<Record<SeedUserKey, { role: CompanyRole; departments: readonly string[]; teams: readonly string[] }>>;
}

export interface SeedOrg {
  id: string;
  slug: string;
  departments: Record<string, string>;
  teams: Record<string, string>;
}

export interface SeedResult {
  users: Record<SeedUserKey, string>;
  orgs: { acme: SeedOrg; globex: SeedOrg };
}

/** `dev|<key>` subjects let the dev sign-in map to seeded users. */
export const devAuthSubject = (key: string) => `dev|${key}`;

async function upsertUsers(tx: Tx): Promise<Record<SeedUserKey, string>> {
  const out = {} as Record<SeedUserKey, string>;
  for (const [key, u] of Object.entries(SEED_USERS) as [SeedUserKey, (typeof SEED_USERS)[SeedUserKey]][]) {
    const [row] = await tx
      .insert(users)
      .values({ authSubject: devAuthSubject(key), email: u.email, displayName: u.name })
      .onConflictDoUpdate({
        target: users.authSubject,
        set: { email: u.email, displayName: u.name, updatedAt: sql`now()` },
      })
      .returning({ id: users.id });
    out[key] = row!.id;
  }
  return out;
}

async function upsertOrg(tx: Tx, slug: string, spec: OrgSpec, userIds: Record<SeedUserKey, string>): Promise<SeedOrg> {
  const [org] = await tx
    .insert(organizations)
    .values({ slug, name: spec.name })
    .onConflictDoUpdate({ target: organizations.slug, set: { name: spec.name, updatedAt: sql`now()` } })
    .returning({ id: organizations.id });
  const organizationId = org!.id;
  const result: SeedOrg = { id: organizationId, slug, departments: {}, teams: {} };

  for (const [deptSlug, dept] of Object.entries(spec.departments)) {
    const [d] = await tx
      .insert(departments)
      .values({ organizationId, slug: deptSlug, name: dept.name })
      .onConflictDoUpdate({
        target: [departments.organizationId, departments.slug],
        set: { name: dept.name, archivedAt: null, updatedAt: sql`now()` },
      })
      .returning({ id: departments.id });
    result.departments[deptSlug] = d!.id;
    for (const [teamSlug, teamName] of Object.entries(dept.teams)) {
      const [t] = await tx
        .insert(teams)
        .values({ organizationId, departmentId: d!.id, slug: teamSlug, name: teamName })
        .onConflictDoUpdate({
          target: [teams.organizationId, teams.departmentId, teams.slug],
          set: { name: teamName, archivedAt: null, updatedAt: sql`now()` },
        })
        .returning({ id: teams.id });
      result.teams[teamSlug] = t!.id;
    }
  }

  for (const [userKey, m] of Object.entries(spec.members) as [SeedUserKey, NonNullable<OrgSpec["members"][SeedUserKey]>][]) {
    const userId = userIds[userKey];
    await tx
      .insert(memberships)
      .values({ organizationId, userId, role: m.role, status: "active" })
      .onConflictDoUpdate({
        target: [memberships.organizationId, memberships.userId],
        set: { role: m.role, status: "active", updatedAt: sql`now()` },
      });
    for (const deptSlug of m.departments) {
      await tx
        .insert(departmentMemberships)
        .values({ organizationId, departmentId: result.departments[deptSlug]!, userId, status: "active" })
        .onConflictDoUpdate({
          target: [departmentMemberships.departmentId, departmentMemberships.userId],
          set: { status: "active", updatedAt: sql`now()` },
        });
    }
    for (const teamSlug of m.teams) {
      await tx
        .insert(teamMemberships)
        .values({ organizationId, teamId: result.teams[teamSlug]!, userId, status: "active" })
        .onConflictDoUpdate({
          target: [teamMemberships.teamId, teamMemberships.userId],
          set: { status: "active", updatedAt: sql`now()` },
        });
    }
  }
  return result;
}

/** Seed companies, structure, users and memberships. Self-contained; no briefings. */
export async function seedOrganizations(db: Database): Promise<SeedResult> {
  return withSystemContext(db, async (tx) => {
    const userIds = await upsertUsers(tx);
    const acme = await upsertOrg(tx, "acme", SEED_ORGS.acme, userIds);
    const globex = await upsertOrg(tx, "globex", SEED_ORGS.globex, userIds);
    return { users: userIds, orgs: { acme, globex } };
  });
}

export type SeedBriefings = (handle: DatabaseHandle, seed: SeedResult) => Promise<void>;

/**
 * TODO(domain): briefing fixtures (representative strategy briefing, a
 * team-restricted brief, a private draft) are implemented by the domain
 * package in `packages/domain/src/seed/briefings.ts`, exporting
 * `seedBriefings: SeedBriefings`. It is loaded dynamically so this package
 * does not depend on @cerebro/domain. Skipped when the file does not exist.
 */
export async function runBriefingSeedHook(handle: DatabaseHandle, seed: SeedResult): Promise<"ran" | "missing"> {
  const file = join(findRepoRoot(), "packages", "domain", "src", "seed", "briefings.ts");
  if (!existsSync(file)) return "missing";
  const mod = (await import(pathToFileURL(file).href)) as { seedBriefings?: SeedBriefings };
  if (typeof mod.seedBriefings !== "function") throw new Error(`${file} does not export seedBriefings`);
  await mod.seedBriefings(handle, seed);
  return "ran";
}

/** Full dev seed: organizations, then the briefing fixture hook. */
export async function seed(target: Database | DatabaseHandle, opts: { briefings?: boolean } = {}): Promise<SeedResult> {
  const handle = handleOf(target);
  const result = await seedOrganizations(handle.db);
  if (opts.briefings ?? true) await runBriefingSeedHook(handle, result);
  return result;
}
