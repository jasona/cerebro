import { beforeEach, describe, expect, it } from "vitest";
import { getCompanyBySlug } from "../org/index";
import { expectDomainError, grant, makeBriefing } from "../org/test-support";
import { createTestWorld, type TestWorld } from "../testing";
import { getFeaturedBriefing, listLibrary, listMyDrafts, searchBriefings } from "./index";

let w: TestWorld;

beforeEach(async () => {
  w = await createTestWorld();
  return () => w.h.close();
});

const ids = (rows: { briefingId: string }[]) => rows.map((r) => r.briefingId).sort();

describe("library discovery (TEAM_WORKSPACES acceptance)", () => {
  it("1. a member finds another department's company-visible brief without an invitation", async () => {
    const b = await makeBriefing(w, { owner: "jordan", homeTeam: "marketing", title: "Launch pricing plan" });
    // Sam is in Engineering / Applications only.
    const page = await listLibrary(w.h.db, w.ctx("sam"), { scope: { kind: "company" } });
    expect(ids(page.items)).toContain(b.id);
    const row = page.items.find((r) => r.briefingId === b.id)!;
    expect(row).toMatchObject({
      title: "Launch pricing plan",
      headline: "Launch pricing plan headline",
      summary: "Launch pricing plan summary text.",
      author: { id: w.seed.users.jordan, name: "Jordan Ellis" },
      home: { department: { slug: "go-to-market" }, team: { slug: "marketing" } },
      visibility: "company",
      visibilityLabel: "Company",
      revisionNumber: 1,
    });
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ isUnread: true, hasNewVersion: false });
    const search = await searchBriefings(w.h.db, w.ctx("sam"), "pricing");
    expect(ids(search.items)).toEqual([b.id]);
  });

  it("2. a department page aggregates its own and its teams' briefs", async () => {
    const dept = await makeBriefing(w, { homeDepartment: "product" });
    const platform = await makeBriefing(w, { homeTeam: "platform" });
    const experience = await makeBriefing(w, { homeTeam: "experience" });
    await makeBriefing(w, { owner: "jordan", homeTeam: "marketing" });
    await makeBriefing(w, {}); // company home
    const page = await listLibrary(w.h.db, w.ctx("sam"), {
      scope: { kind: "department", departmentId: w.seed.orgs.acme.departments.product! },
    });
    expect(ids(page.items)).toEqual([dept.id, platform.id, experience.id].sort());
    expect(page.total).toBe(3);
  });

  it("3. the author filter shows a colleague's accessible briefs across homes", async () => {
    const a = await makeBriefing(w, { owner: "maya", homeTeam: "platform" });
    const b = await makeBriefing(w, { owner: "maya", homeTeam: "experience" });
    const c = await makeBriefing(w, { owner: "maya" });
    const hidden = await makeBriefing(w, { owner: "maya", homeTeam: "platform", visibility: "team", audienceTeam: "platform" });
    await makeBriefing(w, { owner: "jordan", homeTeam: "sales" });
    const page = await listLibrary(w.h.db, w.ctx("jordan"), { scope: { kind: "company" }, authorId: w.seed.users.maya });
    expect(ids(page.items)).toEqual([a.id, b.id, c.id].sort());
    expect(ids(page.items)).not.toContain(hidden.id);
    expect(page.total).toBe(3);
  });

  it("4. a team-restricted brief is hidden from non-members in rows, counts and search", async () => {
    const open = await makeBriefing(w, { homeTeam: "platform" });
    const secret = await makeBriefing(w, {
      homeTeam: "platform",
      visibility: "team",
      audienceTeam: "platform",
      title: "Confidential platform reorg",
    });
    const platformScope = { scope: { kind: "team" as const, teamId: w.seed.orgs.acme.teams.platform! } };

    // Alex is on Platform.
    const alex = await listLibrary(w.h.db, w.ctx("alex"), platformScope);
    expect(ids(alex.items)).toEqual([open.id, secret.id].sort());
    expect(alex.total).toBe(2);
    expect(alex.items.find((r) => r.briefingId === secret.id)!.visibilityLabel).toBe("Platform team");

    // Sam (Engineering) and Priya (explicit Product department member) are not.
    for (const user of ["sam", "priya"] as const) {
      const company = await listLibrary(w.h.db, w.ctx(user), { scope: { kind: "company" } });
      expect(ids(company.items)).toEqual([open.id]);
      expect(company.total).toBe(1);
      const team = await listLibrary(w.h.db, w.ctx(user), platformScope);
      expect(ids(team.items)).toEqual([open.id]);
      expect(team.total).toBe(1);
      const dept = await listLibrary(w.h.db, w.ctx(user), {
        scope: { kind: "department", departmentId: w.seed.orgs.acme.departments.product! },
      });
      expect(dept.total).toBe(1);
      expect(await searchBriefings(w.h.db, w.ctx(user), "confidential")).toEqual({ items: [], total: 0 });
      const q = await listLibrary(w.h.db, w.ctx(user), { q: "reorg" });
      expect(q).toMatchObject({ items: [], total: 0 });
    }
    // Company admins get no implicit access (D09).
    expect((await listLibrary(w.h.db, w.ctx("riley"), { scope: { kind: "company" } })).total).toBe(1);
  });

  it("5. company discovery never exposes drafts", async () => {
    const draftOnly = await makeBriefing(w, { revisions: 0, draft: true, title: "Unreleased idea" });
    const published = await makeBriefing(w, { draft: true, title: "Released title", draftTitle: "Secret new draft title" });
    for (const user of ["sam", "maya"] as const) {
      const page = await listLibrary(w.h.db, w.ctx(user));
      expect(ids(page.items)).toEqual([published.id]);
      expect(page.items[0]!.title).toBe("Released title");
      expect((await searchBriefings(w.h.db, w.ctx(user), "unreleased")).total).toBe(0);
      expect((await searchBriefings(w.h.db, w.ctx(user), "secret")).total).toBe(0);
    }
    // My drafts: only for collaborators.
    const mine = await listMyDrafts(w.h.db, w.ctx("maya"));
    expect(ids(mine)).toEqual([draftOnly.id, published.id].sort());
    const d = mine.find((r) => r.briefingId === published.id)!;
    expect(d).toMatchObject({ title: "Secret new draft title", lockVersion: 1, roles: ["owner"], currentRevisionNumber: 1 });
    expect(await listMyDrafts(w.h.db, w.ctx("sam"))).toEqual([]);
    await grant(w, draftOnly.id, "sam", "editor");
    expect(ids(await listMyDrafts(w.h.db, w.ctx("sam")))).toEqual([draftOnly.id]);
    await grant(w, published.id, "alex", "reader");
    expect(await listMyDrafts(w.h.db, w.ctx("alex"))).toEqual([]);
  });

  it("7. an invited external reader can open their briefing but cannot browse", async () => {
    const b = await makeBriefing(w, { visibility: "restricted", title: "Partner terms" });
    await grant(w, b.id, "casey", "reader");
    const casey = w.ctx("casey");
    await expectDomainError(listLibrary(w.h.db, casey), "not_found");
    await expectDomainError(
      listLibrary(w.h.db, casey, { scope: { kind: "team", teamId: w.seed.orgs.acme.teams.platform! } }),
      "not_found",
    );
    expect(await searchBriefings(w.h.db, casey, "partner")).toEqual({ items: [], total: 0 });
    expect(await getFeaturedBriefing(w.h.db, casey)).toBeNull();
    expect(await listMyDrafts(w.h.db, casey)).toEqual([]);
    await expectDomainError(getCompanyBySlug(w.h.db, w.seed.users.casey, "acme"), "not_found");
    const res = await getCompanyBySlug(w.h.db, w.seed.users.casey, "acme", { briefingSlug: b.slug });
    expect(res).toMatchObject({ org: { slug: "acme" }, membership: null });
    // Another company's member cannot browse Acme either.
    await expectDomainError(listLibrary(w.h.db, { ...w.ctx("taylor"), organizationId: w.seed.orgs.acme.id }), "not_found");
  });
});

describe("library views", () => {
  it("excludes archived and withdrawn briefs", async () => {
    const ok = await makeBriefing(w);
    await makeBriefing(w, { archived: true });
    await makeBriefing(w, { withdrawn: true });
    const page = await listLibrary(w.h.db, w.ctx("sam"));
    expect(ids(page.items)).toEqual([ok.id]);
    expect(page.total).toBe(1);
  });

  it("team scope labels parent announcements separately", async () => {
    const team = await makeBriefing(w, { homeTeam: "platform" });
    const dept = await makeBriefing(w, { homeDepartment: "product" });
    const company = await makeBriefing(w);
    await makeBriefing(w, { homeDepartment: "finance" });
    await makeBriefing(w, { homeTeam: "experience" });
    const page = await listLibrary(w.h.db, w.ctx("maya"), { scope: { kind: "team", teamId: w.seed.orgs.acme.teams.platform! } });
    expect(ids(page.items)).toEqual([team.id]);
    expect(ids(page.parentAnnouncements!)).toEqual([dept.id, company.id].sort());
  });

  it("paginates with a cursor and sorts by title or recency", async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const titles = ["Charlie", "alpha", "Bravo", "delta", "Echo"];
    const made = [];
    for (const [i, title] of titles.entries()) made.push(await makeBriefing(w, { title, publishedAt: new Date(base + i * 60_000) }));
    const byTitle = await listLibrary(w.h.db, w.ctx("sam"), { sort: "title", limit: 2 });
    expect(byTitle.items.map((r) => r.title)).toEqual(["alpha", "Bravo"]);
    expect(byTitle.total).toBe(5);
    const next = await listLibrary(w.h.db, w.ctx("sam"), { sort: "title", limit: 2, cursor: byTitle.nextCursor });
    expect(next.items.map((r) => r.title)).toEqual(["Charlie", "delta"]);
    const last = await listLibrary(w.h.db, w.ctx("sam"), { sort: "title", limit: 2, cursor: next.nextCursor });
    expect(last.items.map((r) => r.title)).toEqual(["Echo"]);
    expect(last.nextCursor).toBeNull();
    const recent = await listLibrary(w.h.db, w.ctx("sam"), { limit: 1 });
    expect(recent.items[0]!.title).toBe("Echo");
    await expectDomainError(listLibrary(w.h.db, w.ctx("sam"), { cursor: "garbage" }), "validation");
  });

  it("searches author names and home metadata, and rejects cross-company scopes", async () => {
    const b = await makeBriefing(w, { owner: "jordan", homeTeam: "sales" });
    expect(ids((await searchBriefings(w.h.db, w.ctx("sam"), "jordan")).items)).toEqual([b.id]);
    expect(ids((await searchBriefings(w.h.db, w.ctx("sam"), { q: "sales" })).items)).toEqual([b.id]);
    expect((await searchBriefings(w.h.db, w.ctx("sam"), "100%_")).total).toBe(0);
    await expectDomainError(
      listLibrary(w.h.db, w.ctx("sam"), { scope: { kind: "team", teamId: w.seed.orgs.globex.teams.logistics! } }),
      "not_found",
    );
  });

  it("features the most recent company-home, company-visible brief", async () => {
    await makeBriefing(w, { publishedAt: new Date("2026-01-01") });
    const latest = await makeBriefing(w, { publishedAt: new Date("2026-02-01") });
    await makeBriefing(w, { homeDepartment: "product", publishedAt: new Date("2026-03-01") });
    await makeBriefing(w, { visibility: "restricted", publishedAt: new Date("2026-04-01") });
    expect((await getFeaturedBriefing(w.h.db, w.ctx("sam")))?.briefingId).toBe(latest.id);
  });
});
