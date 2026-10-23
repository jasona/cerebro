/**
 * Security review follow-ups (D10). Each test exercises the real domain
 * services under the runtime role.
 *
 * Connection revocation (item 5) is enforced by the MCP adapter, which
 * authenticates every request statelessly; see packages/integrations/README.md.
 * Tests: packages/integrations/test/mcp.test.ts "a revoked connection is
 * unauthenticated on the next request", and lifecycle.test.ts "a revoked
 * connection token stops working on the next request".
 */
import { ProviderRegistry, type AiProvider, type AiTask, type ProviderResult, type TaskInput, type TaskOutput } from "@cerebro/ai";
import { briefings, departmentMemberships, engagementInsights, memberships, teamMemberships, teams } from "@cerebro/database";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeAudience, createBriefing, grantAccess, moveBriefingHome } from "../../src/briefings/index";
import {
  askQuestion,
  getAuthorFeedback,
  getEngagementSummary,
  recordEngagementEvent,
  requestTopicSummary,
  setAiRegistry,
} from "../../src/engagement/index";
import { changeMemberRole, removeMembership } from "../../src/org/index";
import { makeDraft, makePublished } from "../../src/publication/test-utils";
import { seedBriefings } from "../../src/seed/index";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { drain, expectCode, NRR_QUESTION, sys } from "./helpers";

let w: TestWorld;
beforeEach(async () => {
  w = await createTestWorld();
});
afterEach(async () => {
  setAiRegistry(undefined);
  await w.h.close();
});

// ---------------------------------------------------------------------------
// 1. Engagement summary counts are cohort-suppressed
// ---------------------------------------------------------------------------

describe("getEngagementSummary suppresses counts drawn from fewer than minCohort readers", () => {
  it("questionsAsked and activity counts are null with a suppressed flag until 3 distinct readers contribute", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    // One reader asking many questions is still a cohort of one.
    for (let i = 0; i < 3; i++) await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    await askQuestion(w.h.db, w.ctx("priya"), { briefingId: p.briefingId, question: NRR_QUESTION });
    for (const [user, key] of [["alex", "session-aaaa1"], ["alex", "session-aaaa2"], ["priya", "session-bbbb1"]] as const) {
      await recordEngagementEvent(w.h.db, w.ctx(user), { briefingId: p.briefingId, revisionNumber: 1, type: "open", sessionKey: key });
      await recordEngagementEvent(w.h.db, w.ctx(user), { briefingId: p.briefingId, revisionNumber: 1, type: "evidence_open", sessionKey: key });
    }

    let s = await getEngagementSummary(w.h.db, w.ctx("maya"), p.briefingId);
    expect(s.minCohort).toBe(3);
    expect(s.revisions[0]!.measured).toMatchObject({
      questionsAsked: null,
      questionsAskedSuppressed: true,
      opens: null,
      opensSuppressed: true,
      evidenceOpens: null,
      evidenceOpensSuppressed: true,
      sectionViews: null,
      sectionViewsSuppressed: true,
      distinctReaders: { value: null, suppressed: true },
    });

    await askQuestion(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, question: NRR_QUESTION });
    await recordEngagementEvent(w.h.db, w.ctx("jordan"), { briefingId: p.briefingId, revisionNumber: 1, type: "open", sessionKey: "session-cccc1" });
    s = await getEngagementSummary(w.h.db, w.ctx("maya"), p.briefingId);
    expect(s.revisions[0]!.measured).toMatchObject({
      questionsAsked: 5,
      questionsAskedSuppressed: false,
      opens: 4,
      opensSuppressed: false,
      distinctReaders: { value: 3, suppressed: false },
      // Only two distinct readers opened evidence.
      evidenceOpens: null,
      evidenceOpensSuppressed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Named readers by user id: members or existing grantees only
// ---------------------------------------------------------------------------

describe("readerUserIds accept only active members or existing grantees of the briefing", () => {
  const MISSING = "00000000-0000-4000-8000-0000000000ab";

  it("createBriefing rejects unknown, external and other-company users with one uniform error", async () => {
    const restricted = (readerUserIds: string[]) => makeDraft(w, { user: "maya", audience: { visibility: "restricted", readerUserIds } });
    const errors = [
      await expectCode(restricted([MISSING]), "validation"),
      await expectCode(restricted([w.seed.users.casey]), "validation"),
      await expectCode(restricted([w.seed.users.taylor]), "validation"),
    ];
    for (const e of errors) expect(e.message).toBe(errors[0]!.message);
    expect(errors.map((e) => (e.details as { field: string }).field)).toEqual(["readerUserIds", "readerUserIds", "readerUserIds"]);
    // Nothing was created by the rejected attempts.
    expect(await sys(w, (tx) => tx.select().from(briefings))).toHaveLength(0);

    await restricted([w.seed.users.sam]);
  });

  it("changeAudience accepts an existing grantee of that briefing, but not a grantee of another briefing", async () => {
    const a = await makePublished(w, { user: "maya", audience: { visibility: "restricted", readerUserIds: [w.seed.users.alex] } });
    const b = await makePublished(w, { user: "maya", audience: { visibility: "restricted", readerUserIds: [w.seed.users.alex] } });
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: a.briefingId, userId: w.seed.users.casey, role: "reader" });

    await changeAudience(w.h.db, w.ctx("maya"), {
      briefingId: a.briefingId,
      audience: { visibility: "restricted", readerUserIds: [w.seed.users.casey] },
    });
    const viaOther = await expectCode(
      changeAudience(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, audience: { visibility: "restricted", readerUserIds: [w.seed.users.casey] } }),
      "validation",
    );
    const missing = await expectCode(
      changeAudience(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, audience: { visibility: "restricted", readerUserIds: [MISSING] } }),
      "validation",
    );
    expect(viaOther.message).toBe(missing.message);
  });

  it("a removed member can no longer be named by id", async () => {
    await removeMembership(w.h.db, w.ctx("riley"), { userId: w.seed.users.sam });
    await expectCode(makeDraft(w, { user: "maya", audience: { visibility: "restricted", readerUserIds: [w.seed.users.sam] } }), "validation");
  });
});

// ---------------------------------------------------------------------------
// 3. summarize_topics never trusts the provider's counts
// ---------------------------------------------------------------------------

type TopicsIn = { questions: { id: string; readerHash: string }[] };

/** A provider that inflates distinct-reader counts and invents question ids. */
function lyingProvider(claim: (input: TopicsIn) => unknown): AiProvider {
  return {
    id: "deterministic",
    model: "liar",
    external: false,
    supports: (task) => task === "summarize_topics",
    async run<T extends AiTask>(_task: T, input: TaskInput<T>): Promise<ProviderResult<TaskOutput<T>>> {
      return { output: claim(input as TopicsIn) as TaskOutput<T>, usage: {}, latencyMs: 0, provider: "deterministic", model: "liar" };
    },
  };
}

describe("summarize_topics computes distinct readers from stored reader hashes", () => {
  it("suppresses a topic whose questions come from fewer than 3 readers, whatever the provider claims", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: NRR_QUESTION });
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: p.briefingId, question: "What is the pilot budget?" });
    await askQuestion(w.h.db, w.ctx("priya"), { briefingId: p.briefingId, question: "Who approves the budget?" });
    setAiRegistry(
      new ProviderRegistry({
        providers: [
          lyingProvider((input) => ({
            topics: [
              {
                label: "Budget",
                count: 40,
                distinctReaders: 25,
                exampleQuestionIds: input.questions.slice(0, 3).map((q) => q.id),
                questionIds: [...input.questions.map((q) => q.id), "invented-1", "invented-2"],
              },
            ],
            suppressedQuestions: 0,
          })),
        ],
      }),
    );
    await requestTopicSummary(w.h.db, w.ctx("maya"), p.briefingId);
    await drain(w);

    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    expect(out.topics).toEqual([]);
    expect(out.suppressedQuestionCount).toBe(3);
    const stored = await sys(w, (tx) => tx.select().from(engagementInsights).where(eq(engagementInsights.briefingId, p.briefingId)));
    expect(stored.map((r) => r.topic)).toEqual(["__suppressed__"]);
  });

  it("stores the computed reader and question counts, ignoring invented ids", async () => {
    const p = await makePublished(w, { user: "maya" });
    await drain(w);
    for (const u of ["alex", "priya", "jordan"] as const) {
      await askQuestion(w.h.db, w.ctx(u), { briefingId: p.briefingId, question: NRR_QUESTION });
    }
    setAiRegistry(
      new ProviderRegistry({
        providers: [
          lyingProvider((input) => ({
            topics: [
              {
                label: "Retention",
                count: 99,
                distinctReaders: 1,
                exampleQuestionIds: ["invented-1", input.questions[0]!.id],
                questionIds: [...input.questions.map((q) => q.id), "invented-2"],
              },
            ],
            suppressedQuestions: 0,
          })),
        ],
      }),
    );
    await requestTopicSummary(w.h.db, w.ctx("maya"), p.briefingId);
    await drain(w);

    const out = await getAuthorFeedback(w.h.db, w.ctx("maya"), { briefingId: p.briefingId });
    expect(out.topics).toHaveLength(1);
    expect(out.topics[0]).toMatchObject({ topic: "Retention", readerCount: 3, questionCount: 3 });
    expect(out.suppressedQuestionCount).toBe(0);
    const [row] = await sys(w, (tx) =>
      tx.select().from(engagementInsights).where(and(eq(engagementInsights.briefingId, p.briefingId), eq(engagementInsights.topic, "Retention"))),
    );
    expect(row!.supportingRefs).toEqual([{ type: "question", id: expect.not.stringMatching(/^invented/) }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Home authorization for createBriefing / moveBriefingHome
// ---------------------------------------------------------------------------

describe("briefing home authorization (D10)", () => {
  const acme = () => w.seed.orgs.acme;
  const create = (user: "maya" | "priya" | "riley" | "alex", home: { departmentId?: string; teamId?: string }) =>
    createBriefing(w.h.db, w.ctx(user), { markdown: "# Home test\n\nA position.", home, audience: { visibility: "company" } });

  it("members may home only in the company, their departments (explicit or via a team) and their teams", async () => {
    const { departments: d, teams: t } = acme();
    // Maya: Platform and Experience teams, no explicit department.
    await create("maya", {});
    await create("maya", { departmentId: d.product });
    await create("maya", { teamId: t.platform });
    for (const home of [{ departmentId: d.finance }, { teamId: t.planning }, { teamId: t.infrastructure }]) {
      const e = await expectCode(create("maya", home), "forbidden");
      expect((e.details as { reason: string }).reason).toBe("not_authorized");
    }
    // Priya: explicit Product department member, Planning team.
    await create("priya", { departmentId: d.product });
    await create("priya", { departmentId: d.finance });
    await create("priya", { teamId: t.planning });
    // Parent department membership alone does not authorize a team home.
    await expectCode(create("priya", { teamId: t.platform }), "forbidden");
  });

  it("company owners and admins may home anywhere in the company", async () => {
    const { departments: d, teams: t } = acme();
    await create("riley", { teamId: t.sales });
    await create("riley", { departmentId: d.finance });
    await expectCode(create("alex", { teamId: t.sales }), "forbidden");
    await changeMemberRole(w.h.db, w.ctx("riley"), { userId: w.seed.users.alex, role: "admin" });
    await create("alex", { teamId: t.sales });
  });

  it("moveBriefingHome applies the same rule to the mover", async () => {
    const { departments: d, teams: t } = acme();
    const b = await makeDraft(w, { user: "maya", home: { teamId: t.platform } });
    await moveBriefingHome(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, home: { teamId: t.experience } });
    await expectCode(moveBriefingHome(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, home: { departmentId: d.finance } }), "forbidden");
    // An editor moves within their own teams only.
    await grantAccess(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, userId: w.seed.users.alex, role: "editor" });
    await moveBriefingHome(w.h.db, w.ctx("alex"), { briefingId: b.briefingId, home: { teamId: t.infrastructure } });
    await expectCode(moveBriefingHome(w.h.db, w.ctx("alex"), { briefingId: b.briefingId, home: { teamId: t.marketing } }), "forbidden");
    // Losing team membership removes the destination.
    await sys(w, (tx) =>
      tx.update(teamMemberships).set({ status: "removed" }).where(and(eq(teamMemberships.teamId, t.platform!), eq(teamMemberships.userId, w.seed.users.maya))),
    );
    await expectCode(moveBriefingHome(w.h.db, w.ctx("maya"), { briefingId: b.briefingId, home: { teamId: t.platform } }), "forbidden");
  });

  it("seeded briefings are homed where their authors are members", async () => {
    await seedBriefings(w.h, w.seed);
    const rows = await sys(w, (tx) => tx.select().from(briefings));
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      await sys(w, async (tx) => {
        const [m] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.organizationId, b.organizationId), eq(memberships.userId, b.ownerId), eq(memberships.status, "active")));
        expect(m, b.title).toBeTruthy();
        if (m!.role === "owner" || m!.role === "admin") return;
        if (b.homeTeamId) {
          const tm = await tx
            .select()
            .from(teamMemberships)
            .where(and(eq(teamMemberships.teamId, b.homeTeamId), eq(teamMemberships.userId, b.ownerId), eq(teamMemberships.status, "active")));
          expect(tm, b.title).toHaveLength(1);
        } else if (b.homeDepartmentId) {
          const dm = await tx
            .select()
            .from(departmentMemberships)
            .where(and(eq(departmentMemberships.departmentId, b.homeDepartmentId), eq(departmentMemberships.userId, b.ownerId)));
          const viaTeam = await tx
            .select()
            .from(teamMemberships)
            .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
            .where(and(eq(teams.departmentId, b.homeDepartmentId), eq(teamMemberships.userId, b.ownerId)));
          expect(dm.length + viaTeam.length, b.title).toBeGreaterThan(0);
        }
      });
    }
    // Priya's Finance brief sits in Planning, where she is a member.
    const planning = rows.find((r) => r.ownerId === w.seed.users.priya);
    expect(planning?.homeTeamId).toBe(w.seed.orgs.acme.teams.planning);
  });
});
