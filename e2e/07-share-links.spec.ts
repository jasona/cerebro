import { expect, test } from "@playwright/test";
import { STRATEGY, contextAs, signInAs } from "./helpers";

test.describe("access and share links", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("a share link opens the reader for an audience member, and a revoked link shows a neutral page", async ({ browser }) => {
    const riley = await contextAs(browser, "riley");
    const maya = await contextAs(browser, "maya");
    try {
      await riley.page.goto(`${STRATEGY}/access`);
      const links = riley.page.getByRole("region", { name: "Share links" });
      await links.getByRole("combobox", { name: "Opens" }).selectOption({ label: "The latest version (stable)" });
      await links.getByRole("button", { name: "Create link" }).click();
      const secret = links.getByRole("textbox", { name: "Share link" });
      await expect(secret).toBeVisible();
      const url = await secret.inputValue();
      expect(url).toMatch(/\/s\/[^/]+$/);
      const path = new URL(url).pathname;

      await maya.page.goto(path);
      await maya.page.waitForURL((u) => u.pathname === STRATEGY);
      await expect(maya.page.getByRole("region", { name: "The decision" })).toBeVisible();

      // Revoke (the list refreshes after the action).
      await riley.page.reload();
      const revoke = riley.page.getByRole("region", { name: "Share links" }).getByRole("button", { name: "Revoke link" });
      await expect(revoke).toHaveCount(1);
      await revoke.click();
      await expect(revoke).toHaveCount(0);

      await maya.page.goto(path);
      await expect(maya.page.getByRole("heading", { level: 1, name: "This link is no longer available" })).toBeVisible();
      expect(new URL(maya.page.url()).pathname).toBe(path);
      // Neutral: no briefing content leaks.
      await expect(maya.page.getByText("Approve a 90-day mid-market pilot.")).toHaveCount(0);
      await expect(maya.page.getByText("focused move upmarket")).toHaveCount(0);
    } finally {
      await riley.context.close();
      await maya.context.close();
    }
  });

  test("granting and revoking direct access", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto(`${STRATEGY}/access`);
    const people = page.getByRole("region", { name: "People with direct access" });
    await people.getByRole("textbox", { name: "Email (required)" }).fill("sam@acme.example");
    await people.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: "Reader" });
    await people.getByRole("button", { name: "Grant access" }).click();
    const revoke = people.getByRole("button", { name: "Revoke reader access for Sam Taylor" });
    await expect(revoke).toBeVisible();
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    // Casey's seeded grant is untouched.
    await expect(people.getByRole("button", { name: "Revoke reader access for Casey Morgan" })).toBeVisible();
  });
});
