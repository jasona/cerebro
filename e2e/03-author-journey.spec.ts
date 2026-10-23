import { expect, test } from "@playwright/test";
import { STRATEGY, editAndSave, publishFromPreview, signInAs, uid } from "./helpers";

test.describe("author journey", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("Riley edits the headline, previews, publishes and sees the new version in history", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto(`${STRATEGY}/edit`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /All changes saved · draft version \d+/ })).toBeVisible();

    const headline = `A focused move upmarket, proven by a 90-day pilot (${uid()})`;
    await editAndSave(page, "Headline (required)", headline);

    await page.getByRole("navigation", { name: "Briefing views" }).getByRole("link", { name: "Preview & publish" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Preview and publish" })).toBeVisible();
    const review = page.getByRole("complementary", { name: "Review" });
    await expect(review).toContainText("Everyone at Acme (company-wide)");
    await expect(review.getByText("Changes since version")).toBeVisible();
    await expect(page.getByText("Publishing releases this exact content to Everyone at Acme (company-wide).")).toBeVisible();
    // The reader preview shows the edited headline.
    await expect(page.getByRole("region", { name: "Reader preview" }).getByText(headline).first()).toBeVisible();

    const n = await publishFromPreview(page, `Sharpened the headline (${headline}).`);
    expect(page.url()).toContain(`${STRATEGY}?published=${n}`);
    await expect(page.getByRole("main").getByText(headline).first()).toBeVisible();

    // History shows the new version as current, and compare works.
    await page.goto(`${STRATEGY}/history`);
    const versions = page.getByRole("region", { name: "Versions" });
    await expect(versions.getByRole("heading", { level: 3, name: `Version ${n}` })).toBeVisible();
    await expect(versions.getByText("Sharpened the headline")).toBeVisible();
    await versions.getByRole("link", { name: "Compare with previous" }).first().click();
    const compare = page.getByRole("region", { name: "Compare" });
    await expect(compare.getByText(`Version ${n - 1} → Version ${n}`)).toBeVisible();
    await expect(compare).toContainText(/headline/i);

    // The compare form works too (version 1 → current).
    await compare.getByRole("combobox", { name: "From" }).selectOption({ label: "Version 1" });
    await compare.getByRole("combobox", { name: "To" }).selectOption({ label: `Version ${n}` });
    await compare.getByRole("button", { name: "Compare" }).click();
    await expect(compare.getByText(`Version 1 → Version ${n}`)).toBeVisible();
  });
});
