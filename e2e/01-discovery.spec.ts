import { expect, test } from "@playwright/test";
import { PLATFORM_TEAM, PRIVATE_DRAFT_TITLE, STRATEGY, STRATEGY_TITLE, TEAM_PLAN_TITLE, briefLink, signInAs } from "./helpers";

// TEAM_WORKSPACES.md acceptance scenarios, against the seeded workspace.

test.describe("discovery", () => {
  test("Alex finds Maya's company-visible brief without an invitation", async ({ page }) => {
    await signInAs(page, "alex");
    await page.goto("/c/acme");
    const row = page.getByRole("listitem").filter({ has: briefLink(page, "Building a platform teams can trust") });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Author: Maya Chen");
    await expect(row).toContainText("Audience: Company");
    await briefLink(row, "Building a platform teams can trust").click();
    await expect(page.getByRole("heading", { level: 1, name: "Building a platform teams can trust" })).toBeVisible();
  });

  test("the Product department page includes Platform team briefs", async ({ page }) => {
    await signInAs(page, "alex");
    await page.goto("/c/acme/d/product");
    await expect(page.getByRole("heading", { level: 1, name: "Product" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Teams in Product" }).getByRole("link", { name: /Platform/ })).toBeVisible();
    const list = page.getByRole("list", { name: "In Product" });
    // Company-visible and Platform-team-restricted briefs homed in Product / Platform.
    await expect(briefLink(list, "Building a platform teams can trust")).toBeVisible();
    await expect(briefLink(list, TEAM_PLAN_TITLE)).toBeVisible();
    await expect(list.getByText("Home: Product / Platform").first()).toBeVisible();
  });

  test("the author filter narrows the library to one author", async ({ page }) => {
    await signInAs(page, "alex");
    await page.goto("/c/acme");
    const filters = page.getByRole("search", { name: "Filter briefs" });
    await filters.getByRole("combobox", { name: "Author" }).selectOption({ label: "Maya Chen" });
    await filters.getByRole("button", { name: "Apply" }).click();
    await page.waitForURL(/author=/);
    const items = page.getByRole("main").getByRole("listitem").filter({ hasText: /^Author:|Author: / });
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(items.nth(i)).toContainText("Author: Maya Chen");
    await expect(briefLink(page.getByRole("main"), "A sharper story for the mid-market")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Author: Riley Lee")).toHaveCount(0);
  });

  test("a team-restricted Platform brief is absent for Jordan, including search", async ({ page }) => {
    await signInAs(page, "jordan");
    await page.goto("/c/acme");
    await expect(briefLink(page.getByRole("main"), "A sharper story for the mid-market")).toBeVisible();
    await expect(briefLink(page, TEAM_PLAN_TITLE)).toHaveCount(0);

    await page.goto(PLATFORM_TEAM);
    await expect(page.getByRole("heading", { level: 1, name: "Platform" })).toBeVisible();
    await expect(briefLink(page, "Building a platform teams can trust")).toBeVisible();
    await expect(briefLink(page, TEAM_PLAN_TITLE)).toHaveCount(0);

    for (const q of ["Platform readiness", "SSO and audit logs"]) {
      await page.goto(`/c/acme?q=${encodeURIComponent(q)}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(briefLink(page, TEAM_PLAN_TITLE)).toHaveCount(0);
      await expect(page.getByText("Platform can support the pilot")).toHaveCount(0);
    }

    // A team member does find it in search.
    await signInAs(page, "alex");
    await page.goto(`/c/acme?q=${encodeURIComponent("Platform readiness")}`);
    await expect(briefLink(page, TEAM_PLAN_TITLE)).toBeVisible();
  });

  test("Riley's private draft is absent for Maya", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto("/c/acme/drafts");
    const draftLink = page.getByRole("main").getByRole("link", { name: PRIVATE_DRAFT_TITLE }).first();
    await expect(draftLink).toBeVisible();
    const href = await draftLink.getAttribute("href");
    const slugPath = href!.replace(/\/edit.*$/, "").replace(/\?.*$/, "");

    await signInAs(page, "maya");
    await page.goto("/c/acme");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(PRIVATE_DRAFT_TITLE)).toHaveCount(0);
    await page.goto(`/c/acme?q=${encodeURIComponent("Pricing simplification")}`);
    await expect(page.getByText(PRIVATE_DRAFT_TITLE)).toHaveCount(0);
    await page.goto("/c/acme/drafts");
    await expect(page.getByText(PRIVATE_DRAFT_TITLE)).toHaveCount(0);
    const res = await page.goto(slugPath);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(PRIVATE_DRAFT_TITLE)).toHaveCount(0);
  });

  test("Casey (external) gets 404 for the company but can open the shared strategy brief with minimal chrome", async ({ page }) => {
    await signInAs(page, "casey");
    const res = await page.goto("/c/acme");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "We couldn't find that page" })).toBeVisible();

    const ok = await page.goto(STRATEGY);
    expect(ok?.status()).toBe(200);
    await expect(page.getByRole("region", { name: "The decision" })).toBeVisible();
    // Minimal chrome: no workspace rail, company search or library breadcrumb.
    await expect(page.getByRole("complementary", { name: "Workspace" })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search briefs" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open workspace navigation" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Departments & teams" })).toHaveCount(0);

    const edit = await page.goto(`${STRATEGY}/edit`);
    expect(edit?.status()).toBe(404);
  });

  test("Taylor (Globex) cannot open the Acme brief", async ({ page }) => {
    await signInAs(page, "taylor");
    const res = await page.goto(STRATEGY);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(STRATEGY_TITLE)).toHaveCount(0);
    const lib = await page.goto("/c/acme");
    expect(lib?.status()).toBe(404);
  });
});
