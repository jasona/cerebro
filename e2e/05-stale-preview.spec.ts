import { expect, test, type Page } from "@playwright/test";
import { STRATEGY, contextAs } from "./helpers";

async function openEvidenceList(page: Page) {
  const review = page.getByRole("complementary", { name: "Review" });
  const summary = review.locator("summary", { hasText: "Approved and excluded evidence" });
  await summary.click();
  return review;
}

test.describe("stale preview", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("publishing a preview after the evidence changed in another tab is refused with a reason", async ({ browser }) => {
    const a = await contextAs(browser, "riley");
    const b = await contextAs(browser, "riley");
    try {
      for (const p of [a.page, b.page]) {
        await p.goto(`${STRATEGY}/preview`);
        await expect(p.getByRole("button", { name: /^Publish version \d+$/ })).toBeVisible();
      }
      const reviewA = a.page.getByRole("complementary", { name: "Review" });
      await expect(reviewA).toContainText("4 approved");

      // Tab A excludes one approved excerpt; the review refreshes.
      await (await openEvidenceList(a.page)).getByRole("button", { name: "Exclude: Support capacity model" }).click();
      await a.page.waitForURL(/updated=/);
      await expect(reviewA).toContainText("3 approved");
      await expect(reviewA).toContainText("1 excluded");
      await expect(a.page.getByText("This claim will publish without evidence.").first()).toBeVisible();

      // Tab B still shows the old preview; Publish is refused.
      await b.page.getByRole("button", { name: /^Publish version \d+$/ }).click();
      await b.page.waitForURL(/stale=/);
      const alert = b.page.getByRole("alert").filter({ hasText: "Not published: the briefing changed after the preview you reviewed." });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole("listitem").first()).toBeVisible();
      expect((await alert.getByRole("listitem").first().innerText()).trim().length).toBeGreaterThan(0);
      await expect(b.page).not.toHaveURL(/published=/);
      // B now shows a fresh preview of the current draft.
      await expect(b.page.getByRole("complementary", { name: "Review" })).toContainText("1 excluded");

      // Restore the excerpt so later specs see the seeded evidence.
      await (await openEvidenceList(b.page)).getByRole("button", { name: "Approve: Support capacity model" }).click();
      await b.page.waitForURL(/updated=/);
      await expect(b.page.getByRole("complementary", { name: "Review" })).toContainText("4 approved");
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
