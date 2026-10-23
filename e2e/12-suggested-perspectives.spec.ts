import { expect, test } from "@playwright/test";
import { STRATEGY, settle, signInAs } from "./helpers";

/**
 * W3.3: AI-suggested perspectives are proposals. The author accepts one
 * (saved through the normal draft version check) and dismisses another;
 * nothing changes until they act. Uses the offline deterministic provider.
 */
test.describe("suggested perspectives", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("the author accepts one suggested perspective and dismisses another", async ({ page }) => {
    await signInAs(page, "riley");
    await page.goto(`${STRATEGY}/edit`);
    await settle(page);
    const saved = page.getByRole("status").filter({ hasText: /All changes saved · draft version (\d+)/ });
    await expect(saved).toBeVisible();
    const startVersion = Number(/version (\d+)/.exec(await saved.innerText())![1]);

    const panel = page.getByRole("region", { name: "Suggestions" });
    const perspectives = page.getByRole("group", { name: "Perspectives", exact: true });
    const labels = perspectives.getByRole("textbox", { name: "Label (required)", exact: true });
    await expect(labels).toHaveCount(2);

    await panel.getByRole("button", { name: "Suggest perspectives" }).click();
    await expect(panel.getByRole("status")).toContainText("3 suggested perspectives to review below. Nothing changes until you accept one.");
    const delivery = panel.getByRole("article", { name: "Delivery" });
    const risk = panel.getByRole("article", { name: "Risk review" });
    await expect(delivery).toBeVisible();
    await expect(risk).toBeVisible();
    await expect(delivery).toContainText("Rule-based (local, no model)");
    await expect(delivery).toContainText("Emphasises: Next steps");
    // Suggesting changed nothing in the draft.
    await expect(labels).toHaveCount(2);
    await expect(page.getByRole("status").filter({ hasText: `All changes saved · draft version ${startVersion}` })).toBeVisible();

    // Accept: saved as the next draft version through the normal concurrency check.
    await panel.getByRole("button", { name: "Accept suggested perspective “Delivery”" }).click();
    await expect(panel.getByRole("status")).toContainText(`Accepted “Delivery”. Saved as draft version ${startVersion + 1}.`);
    await expect(labels).toHaveCount(3);
    await expect(labels.nth(2)).toHaveValue("Delivery");
    await expect(page.getByRole("status").filter({ hasText: `All changes saved · draft version ${startVersion + 1}` })).toBeVisible();
    await expect(delivery).toHaveCount(0);

    // Dismiss: removed from the list, the draft is untouched.
    await panel.getByRole("button", { name: "Dismiss suggested perspective “Risk review”" }).click();
    await expect(panel.getByRole("status")).toContainText("Dismissed “Risk review”.");
    await expect(risk).toHaveCount(0);
    await expect(labels).toHaveCount(3);

    // After a reload: the accepted perspective is in the draft, the dismissed one is gone, the third is still pending.
    await page.reload();
    await settle(page);
    await expect(labels).toHaveCount(3);
    await expect(labels.nth(2)).toHaveValue("Delivery");
    await expect(panel.getByRole("article", { name: "Risk review" })).toHaveCount(0);
    await expect(panel.getByRole("article", { name: "Decision makers" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: `All changes saved · draft version ${startVersion + 1}` })).toBeVisible();
  });
});
