import { expect, test, type Page } from "@playwright/test";
import { STRATEGY, signInAs } from "./helpers";

// Lightweight accessibility smoke checks (no axe dependency): one h1, a working
// skip link, landmarks, and an accessible name on every form control. Names
// come from Playwright's accessibility tree, so labels, aria-label and
// aria-labelledby all count.

const PAGES: { name: string; path: string }[] = [
  { name: "library", path: "/c/acme" },
  { name: "reader", path: STRATEGY },
  { name: "editor", path: `${STRATEGY}/edit` },
  { name: "preview", path: `${STRATEGY}/preview` },
];

const CONTROL_ROLES = ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "button"];

/** Lines of the ARIA snapshot for form controls that have no accessible name. */
async function unnamedControls(page: Page): Promise<string[]> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const re = new RegExp(`^\\s*- (${CONTROL_ROLES.join("|")})(?=\\s*(\\[|:|$))`);
  return snapshot.split("\n").filter((line) => re.test(line));
}

test.describe("accessibility smoke", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "riley");
  });

  for (const p of PAGES) {
    test(`${p.name}: one h1, skip link, landmarks, named controls`, async ({ page }) => {
      await page.goto(p.path);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

      const h1s = await page.getByRole("heading", { level: 1 }).allInnerTexts();
      // Soft, so the remaining checks still run and report.
      expect.soft(h1s, `h1 elements on ${p.path}`).toHaveLength(1);

      // Skip link: first in tab order, targets the main landmark.
      const skip = page.getByRole("link", { name: "Skip to main content" });
      await expect(skip).toHaveCount(1);
      const target = (await skip.getAttribute("href"))!;
      expect(target).toMatch(/^#.+/);
      await expect(page.locator(target)).toHaveCount(1);
      await expect(page.getByRole("main")).toHaveCount(1);
      expect(await page.getByRole("main").evaluate((el, id) => el.id === id || !!el.querySelector(`#${id}`) || !!el.closest(`#${id}`), target.slice(1))).toBe(true);
      await page.locator("body").focus();
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();

      // Landmarks.
      await expect(page.getByRole("banner")).not.toHaveCount(0);
      await expect(page.getByRole("navigation")).not.toHaveCount(0);

      // Every form control has an accessible name.
      expect(await unnamedControls(page), `unnamed controls on ${p.path}`).toEqual([]);
    });
  }
});
