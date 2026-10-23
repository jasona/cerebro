import { expect, test } from "@playwright/test";
import { PLATFORM_TEAM, briefLink, contextAs, publishFromPreview, uid } from "./helpers";

test.describe("new brief from Markdown", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");
  test.describe.configure({ mode: "serial" });

  // Shared with the follow-up test below.
  let base = "";
  let title = "";

  test("Riley publishes a Markdown brief into the Platform team home and Alex finds it there", async ({ browser }) => {
    const riley = await contextAs(browser, "riley");
    const alex = await contextAs(browser, "alex");
    title = `Platform on-call handbook refresh ${uid()}`;
    const markdown = `# ${title}

We should refresh the platform on-call handbook before the mid-market pilot starts.

## Why now

Pilot accounts will raise new kinds of incidents, and the current handbook predates two shared services.

## The plan

Rewrite the escalation section and add runbooks for the two newest shared services.

Risk: Engineers may skip the refresh during a busy quarter.

## Next steps

- [ ] Draft the new escalation section
- [ ] Review runbooks with each service owner

Request: Tell us which runbook you reach for most often.

_Fictional sample content for end-to-end tests._`;
    try {
      const { page } = riley;
      await page.goto("/c/acme/new?department=product&team=platform");
      await expect(page.getByRole("heading", { level: 1, name: "Start a brief" })).toBeVisible();
      const where = page.getByRole("group", { name: "Where it lives and who can read it" });
      await expect(where.getByRole("combobox", { name: "Home" })).toHaveValue(/.+/);
      expect(await where.getByRole("combobox", { name: "Home" }).locator("option:checked").innerText()).toBe("Acme / Product / Platform");
      await expect(where.getByRole("combobox", { name: "Audience" }).locator("option:checked")).toHaveText("Everyone at Acme (company-wide)");

      await page.getByRole("radio", { name: /^Paste Markdown/ }).check();
      await page.getByRole("textbox", { name: /^Markdown/ }).fill(markdown);
      await page.getByRole("button", { name: "Create draft" }).click();
      await page.waitForURL(/\/edit/);
      base = new URL(page.url()).pathname.replace(/\/edit$/, "");

      // Still a private draft: Alex can't see it yet.
      await alex.page.goto(PLATFORM_TEAM);
      await expect(briefLink(alex.page, title)).toHaveCount(0);

      await page.goto(`${base}/preview`);
      const review = page.getByRole("complementary", { name: "Review" });
      await expect(review).toContainText("Acme / Product / Platform");
      await expect(review).toContainText("Everyone at Acme (company-wide)");
      await publishFromPreview(page);

      await alex.page.goto(PLATFORM_TEAM);
      const list = alex.page.getByRole("list", { name: "Platform briefs" });
      await expect(briefLink(list, title)).toBeVisible();
      await briefLink(list, title).click();
      await alex.page.waitForURL((u) => u.pathname === base);
      await expect(alex.page.getByRole("main").getByText("refresh the platform on-call handbook").first()).toBeVisible();
    } finally {
      await riley.context.close();
      await alex.context.close();
    }
  });
  test("Riley narrows the audience with a confirmation, then withdraws it", async ({ browser }) => {
    expect(base, "depends on the previous test").not.toBe("");
    const riley = await contextAs(browser, "riley");
    const alex = await contextAs(browser, "alex");
    const jordan = await contextAs(browser, "jordan");
    try {
      const { page } = riley;
      await page.goto(`${base}/access`);
      const audience = page.getByRole("region", { name: "Audience" });
      await audience.getByRole("combobox", { name: "New audience" }).selectOption({ label: "Platform team (Product)" });
      await audience.getByRole("button", { name: "Review change" }).click();
      const confirm = audience.getByRole("alertdialog", { name: "Confirm audience change" });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("Everyone at Acme (company-wide)");
      await expect(confirm).toContainText("Platform team");
      await confirm.getByRole("button", { name: "Change audience" }).click();
      await expect(page.getByRole("region", { name: "Audience" }).locator("p").filter({ hasText: "Current audience:" })).toContainText("Platform team");

      // Jordan (Marketing/Sales) loses it; Alex (Platform) keeps it.
      await jordan.page.goto(PLATFORM_TEAM);
      await expect(jordan.page.getByRole("heading", { level: 1, name: "Platform" })).toBeVisible();
      await expect(briefLink(jordan.page, title)).toHaveCount(0);
      expect((await jordan.page.goto(base))?.status()).toBe(404);
      await alex.page.goto(PLATFORM_TEAM);
      await expect(briefLink(alex.page.getByRole("list", { name: "Platform briefs" }), title)).toBeVisible();

      // Withdraw: typed confirmation plus a browser confirm.
      await page.goto(`${base}/history`);
      await page.locator("summary", { hasText: "Withdraw the current publication" }).click();
      await page.getByRole("textbox", { name: "Type withdraw to confirm" }).fill("withdraw");
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: /^Withdraw version \d+$/ }).click();
      await expect(page.getByText("The publication was withdrawn.")).toBeVisible();

      await alex.page.goto(base);
      await expect(alex.page.getByRole("heading", { level: 1, name: "This briefing has been withdrawn" })).toBeVisible();
      await expect(alex.page.getByText("refresh the platform on-call handbook")).toHaveCount(0);
      await alex.page.goto(PLATFORM_TEAM);
      await expect(briefLink(alex.page, title)).toHaveCount(0);
    } finally {
      await riley.context.close();
      await alex.context.close();
      await jordan.context.close();
    }
  });
});
