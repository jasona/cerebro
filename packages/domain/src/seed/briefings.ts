/**
 * Briefing seed fixtures, loaded dynamically by `@cerebro/database`'s seed
 * (`runBriefingSeedHook`). Built through the real domain services, so seeded
 * data obeys the same validation, evidence approval, preview binding and
 * publication transaction as production writes.
 *
 * ALL CONTENT IS FICTIONAL SAMPLE DATA: companies, people, figures and
 * evidence are invented for development and must never be presented as real.
 *
 * Idempotent: an organization that already has any briefing is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  briefings,
  withSystemContext,
  type DatabaseHandle,
  type SeedBriefings,
  type SeedResult,
  type SeedUserKey,
} from "@cerebro/database";
import { markdownToDocument, strategyBriefing, teamPlanBriefing, type BriefingDocument } from "@cerebro/briefing-schema";
import { eq, sql } from "drizzle-orm";
import { createBriefing, getDraft, grantAccess, updateDraft, type AudienceSpec, type HomeSpec } from "../briefings/index";
import type { RequestContext } from "../context";
import { createPreview, publishBriefing } from "../publication/index";

const FICTIONAL = "Fictional sample content for development; not real data.";

const MD = {
  planning: `# FY27 planning calendar and budget guardrails

Finance will run FY27 planning in two passes so departments can commit headcount before the board review.

## Why now

The board review moves earlier this year; a single late pass would leave no time to reconcile department plans.

## The plan

Pass one collects headcount and major spend by department. Pass two reconciles against the guardrails and closes open questions.

Risk: Departments may anchor on last year's run-rate instead of the guardrails.

Assumption: Department leads can submit first-pass numbers within three weeks.

## Next steps

- [ ] Share the planning template with department leads
- [ ] Hold office hours for first-pass submissions

Request: Confirm your department's planning owner by the end of the month.

_${FICTIONAL}_`,

  platformTrust: `# Building a platform teams can trust

Product teams should be able to ship on the platform without filing tickets for access, environments or reviews.

## Why now

Teams increasingly route around the platform to move faster, which fragments security reviews and on-call ownership.

## What we will change

Self-service environments with sensible defaults, clear ownership for every shared service, and published reliability targets.

Tradeoff: We will pause two lower-demand platform features to fund self-service work.

## Next steps

- [ ] Publish ownership for every shared service
- [ ] Pilot self-service environments with two product teams

Request: Tell us which platform request slows your team down most.

_${FICTIONAL}_`,

  infraCapacity: `# Infrastructure capacity for the next stage

We need to plan capacity a year ahead instead of reacting to each launch.

## Why now

Recent launches required emergency capacity changes; each one pulled engineers off planned work.

## Approach

Move to quarterly capacity reviews tied to the product roadmap, with a standing buffer for launches.

Uncertainty: Mid-market pilot demand is not yet known and could change the buffer we need.

## Next steps

- [ ] Agree the first quarterly capacity review date
- [ ] Draft the launch buffer policy

Decision: Approve quarterly capacity reviews starting next quarter.

_${FICTIONAL}_`,

  midMarketStory: `# A sharper story for the mid-market

Our message should speak to operations leaders at growing companies, not to every buyer at once.

## Why now

The mid-market pilot starts soon, and sales conversations still lead with small-business messaging.

## The story

Lead with time-to-value and administration controls; keep pricing simple for the pilot.

Risk: A narrower message could slow small-business inbound in the short term.

## Next steps

- [ ] Draft pilot messaging for review with Sales
- [ ] Update the first-call deck for pilot accounts

Request: Share objections you hear from mid-market prospects.

_${FICTIONAL}_`,

  onboarding: `# Making onboarding feel effortless

New customers should reach their first useful outcome in their first session.

## Why now

Onboarding drop-off is highest before the first outcome, and larger customers need guided setup.

## What we will try

A guided first-run checklist, sample data on day one, and an admin setup path for larger accounts.

Assumption: Most new users can reach a first outcome without talking to support.

## Next steps

- [ ] Prototype the first-run checklist
- [ ] Interview five recently onboarded customers

Request: Point us to customers willing to test the new first-run flow.

_${FICTIONAL}_`,

  privateDraft: `# Pricing simplification (working draft)

Early thinking on reducing the number of plans before the mid-market pilot.

## Open thinking

Three plans may be enough; the enterprise add-ons need a clearer home.

_${FICTIONAL}_`,

  globex: `# Logistics network review

Operations will consolidate two regional hubs to shorten delivery times.

## Why now

Hub utilisation is uneven, and peak-season delays concentrate in one region.

## Next steps

- [ ] Model the consolidation timeline

Request: Flag customer commitments that depend on the current hub layout.

_${FICTIONAL}_`,
} as const;

interface Spec {
  author: SeedUserKey;
  document: BriefingDocument;
  home?: HomeSpec;
  audience: AudienceSpec;
  publish: boolean;
}

function ctxFor(seed: SeedResult, user: SeedUserKey, org: "acme" | "globex"): RequestContext {
  return { userId: seed.users[user], organizationId: seed.orgs[org].id, via: "worker", requestId: `seed-${randomUUID()}` };
}

const fromMarkdown = (md: string) => markdownToDocument(md).document;

async function createSeedBriefing(handle: DatabaseHandle, seed: SeedResult, org: "acme" | "globex", spec: Spec) {
  const db = handle.db;
  const ctx = ctxFor(seed, spec.author, org);
  const created = await createBriefing(db, ctx, { document: spec.document, home: spec.home ?? {}, audience: spec.audience });
  let version = created.draftVersion;
  // Evidence is never approved on arrival; approve, as an explicit author step, what the fixture marks approved.
  const approve = spec.document.evidence.filter((e) => e.status === "approved").map((e) => e.id);
  if (approve.length) {
    const r = await updateDraft(db, ctx, {
      briefingId: created.briefingId,
      expectedVersion: version,
      patch: approve.map((evidenceId) => ({ op: "set_evidence_status" as const, evidenceId, status: "approved" as const })),
    });
    version = r.draftVersion;
  }
  if (spec.publish) await publish(handle, ctx, created.briefingId);
  return { ...created, ctx, version };
}

async function publish(handle: DatabaseHandle, ctx: RequestContext, briefingId: string, changeSummary?: string) {
  const preview = await createPreview(handle.db, ctx, { briefingId });
  return publishBriefing(handle.db, ctx, { briefingId, previewId: preview.previewId, ...(changeSummary ? { changeSummary } : {}) });
}

async function orgHasBriefings(handle: DatabaseHandle, organizationId: string): Promise<boolean> {
  // System context: seed-only existence check across the org (allowed use: seed).
  return withSystemContext(handle.db, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(briefings)
      .where(eq(briefings.organizationId, organizationId));
    return (r?.n ?? 0) > 0;
  });
}

async function seedAcme(handle: DatabaseHandle, seed: SeedResult) {
  const acme = seed.orgs.acme;
  const t = acme.teams;
  const d = acme.departments;

  // Representative strategy briefing: company home, company-visible, revisions 1 and 2.
  const strategy = await createSeedBriefing(handle, seed, "acme", {
    author: "riley",
    document: strategyBriefing,
    audience: { visibility: "company" },
    publish: true,
  });
  const draft = await getDraft(handle.db, strategy.ctx, strategy.briefingId);
  await updateDraft(handle.db, strategy.ctx, {
    briefingId: strategy.briefingId,
    expectedVersion: draft.lockVersion,
    document: {
      ...draft.document,
      request: {
        ...draft.document.request,
        detail: "A focused team. A defined investment. Stop-or-scale criteria agreed with Finance before day one.",
      },
    },
  });
  await publish(handle, strategy.ctx, strategy.briefingId, "Clarified that stop-or-scale criteria are agreed with Finance before the pilot starts.");
  // External reader (no company membership) with an explicit grant.
  await grantAccess(handle.db, strategy.ctx, { briefingId: strategy.briefingId, userId: seed.users.casey, role: "reader" });

  // Team-audience plan for Platform.
  await createSeedBriefing(handle, seed, "acme", {
    author: "maya",
    document: teamPlanBriefing,
    home: { departmentId: d.product, teamId: t.platform },
    audience: { visibility: "team", teamId: t.platform },
    publish: true,
  });

  // Finance / Planning, department audience.
  await createSeedBriefing(handle, seed, "acme", {
    author: "priya",
    document: fromMarkdown(MD.planning),
    home: { departmentId: d.finance, teamId: t.planning },
    audience: { visibility: "department", departmentId: d.finance },
    publish: true,
  });

  // Company-visible briefs from other authors and departments (library concept titles).
  const company: [SeedUserKey, string, HomeSpec][] = [
    ["maya", MD.platformTrust, { departmentId: d.product, teamId: t.platform }],
    ["alex", MD.infraCapacity, { departmentId: d.engineering, teamId: t.infrastructure }],
    ["jordan", MD.midMarketStory, { departmentId: d["go-to-market"], teamId: t.marketing }],
    ["sam", MD.onboarding, { departmentId: d.engineering, teamId: t.applications }],
  ];
  for (const [author, md, home] of company) {
    await createSeedBriefing(handle, seed, "acme", { author, document: fromMarkdown(md), home, audience: { visibility: "company" }, publish: true });
  }

  // Riley's private draft: never published.
  await createSeedBriefing(handle, seed, "acme", {
    author: "riley",
    document: fromMarkdown(MD.privateDraft),
    audience: { visibility: "company" },
    publish: false,
  });
}

async function seedGlobex(handle: DatabaseHandle, seed: SeedResult) {
  await createSeedBriefing(handle, seed, "globex", {
    author: "taylor",
    document: fromMarkdown(MD.globex),
    audience: { visibility: "company" },
    publish: true,
  });
}

export const seedBriefings: SeedBriefings = async (handle, seed) => {
  if (!(await orgHasBriefings(handle, seed.orgs.acme.id))) await seedAcme(handle, seed);
  if (!(await orgHasBriefings(handle, seed.orgs.globex.id))) await seedGlobex(handle, seed);
};
