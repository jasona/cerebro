import { expect, test } from "@playwright/test";
import { PRIVATE_DRAFT_TITLE, signInAs, uid } from "./helpers";

test.describe("rich-text editing", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("formatting typed in a prose field saves and renders in the reader preview", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto("/c/acme/drafts");
    const href = await page.getByRole("main").getByRole("link", { name: PRIVATE_DRAFT_TITLE }).first().getAttribute("href");
    const base = href!.replace(/\/(edit|preview)?(\?.*)?$/, "");
    await page.goto(`${base}/edit`);
    await expect(page.getByRole("status").filter({ hasText: /All changes saved · draft version \d+/ })).toBeVisible();

    const summary = page.getByRole("textbox", { name: "Summary (required)", exact: true });
    const toolbar = page.getByRole("toolbar", { name: "Summary formatting" });
    const bold = toolbar.getByRole("button", { name: "Bold" });
    const italic = toolbar.getByRole("button", { name: "Italic" });
    const tag = uid();

    // Replace the summary: plain text, then bold via the keyboard shortcut.
    await summary.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`Simpler pricing (${tag}) `);
    await expect(bold).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.type("cuts sales cycles");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type(" and ");
    // Italic via the toolbar button; focus stays in the field.
    await italic.click();
    await expect(italic).toHaveAttribute("aria-pressed", "true");
    await expect(summary).toBeFocused();
    await page.keyboard.type("support load");
    await italic.click();
    await page.keyboard.type(".");

    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Saved · draft version \d+/ })).toBeVisible();

    // The saved draft renders the marks for readers.
    await page.goto(`${base}/preview`);
    const preview = page.getByRole("region", { name: "Reader preview" });
    await expect(preview.locator("strong", { hasText: "cuts sales cycles" })).toBeVisible();
    await expect(preview.locator("em", { hasText: "support load" })).toBeVisible();
    await expect(preview.getByText(`Simpler pricing (${tag})`, { exact: false })).toBeVisible();

    // Reloading the editor shows the same formatting, and nothing is unsaved.
    await page.goto(`${base}/edit`);
    await expect(page.getByRole("status").filter({ hasText: /All changes saved · draft version \d+/ })).toBeVisible();
    await expect(summary.locator("strong")).toHaveText("cuts sales cycles");
    await expect(summary.locator("em")).toHaveText("support load");
  });

  test("links are added from the toolbar and the toolbar is one tab stop", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto("/c/acme/drafts");
    const href = await page.getByRole("main").getByRole("link", { name: PRIVATE_DRAFT_TITLE }).first().getAttribute("href");
    const base = href!.replace(/\/(edit|preview)?(\?.*)?$/, "");
    await page.goto(`${base}/edit`);
    await expect(page.getByRole("status").filter({ hasText: /All changes saved · draft version \d+/ })).toBeVisible();

    const stakes = page.getByRole("textbox", { name: "Stakes (required)", exact: true });
    const toolbar = page.getByRole("toolbar", { name: "Stakes formatting" });

    // Arrow keys move within the toolbar (once the editor has mounted).
    await expect(toolbar.getByRole("button", { name: "Bold" })).toBeEnabled();
    await toolbar.getByRole("button", { name: "Bold" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(toolbar.getByRole("button", { name: "Italic" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(toolbar.getByRole("button", { name: "Link" })).toBeFocused();
    await expect(toolbar.getByRole("button", { name: "Bold" })).toHaveAttribute("tabindex", "-1");

    // Ctrl/Cmd+K at the end of the field inserts a link.
    await stakes.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" See ");
    await page.keyboard.press("ControlOrMeta+k");
    const url = page.getByRole("textbox", { name: "Link address" });
    await expect(url).toBeFocused();
    await url.fill("not a url");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Enter a web address, e.g. https://example.com.")).toBeVisible();
    await url.fill("https://example.com/pricing");
    await page.keyboard.press("Enter");
    await expect(stakes).toBeFocused();
    await expect(stakes.getByRole("link", { name: "https://example.com/pricing" })).toBeVisible();

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Saved · draft version \d+/ })).toBeVisible();
    await page.goto(`${base}/preview`);
    await expect(page.getByRole("region", { name: "Reader preview" }).locator('a[href="https://example.com/pricing"]')).toBeVisible();
  });
});
