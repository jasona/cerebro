import { expect, test } from "@playwright/test";
import { signInAs } from "./helpers";

/** Click the visible option label (the radio input itself is visually hidden). */
const choose = (scope: import("@playwright/test").Locator, label: string) => scope.locator("label", { hasText: label }).click();

const background = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("theme switch", () => {
  test.use({ colorScheme: "light" });

  test("an explicit theme overrides the OS, persists across reloads, and System clears it", async ({ page }) => {
    await signInAs(page, "maya", "/c/acme/settings");
    const appearance = page.getByRole("region", { name: "Appearance" });
    const lightBg = await background(page);

    await choose(appearance, "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkBg = await background(page);
    expect(darkBg).not.toBe(lightBg);

    // Applied before hydration on the next load, and the account menu agrees.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await background(page)).toBe(darkBg);
    const menu = page.locator("details", { has: page.locator("summary", { hasText: "Account menu for" }) });
    await menu.locator("summary").click();
    await expect(menu.getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Dark" })).toBeChecked();

    await choose(appearance, "System");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
    expect(await background(page)).toBe(lightBg);
  });

  test("Light wins over a dark OS preference", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signInAs(page, "maya", "/c/acme/settings");
    const darkBg = await background(page);
    await choose(page.getByRole("region", { name: "Appearance" }), "Light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await background(page)).not.toBe(darkBg);
  });
});
