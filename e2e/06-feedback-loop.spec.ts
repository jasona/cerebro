import { expect, test } from "@playwright/test";
import { STRATEGY, contextAs, editAndSave, publishFromPreview, readerVersion, uid } from "./helpers";

// End-to-end proof step 3: the author uses submitted reader feedback to publish a clearer revision.
test.describe("feedback loop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("Maya's feedback reaches Riley, who publishes a clarifying revision and resolves it against that version", async ({ browser }) => {
    const maya = await contextAs(browser, "maya");
    const riley = await contextAs(browser, "riley");
    try {
      // Maya submits attributed feedback.
      const text = `Which Finance owner signs off the stop-or-scale criteria? (${uid()})`;
      await maya.page.goto(STRATEGY);
      await expect(maya.page.getByRole("region", { name: "The decision" })).toBeVisible();
      const readVersion = await readerVersion(maya.page);
      const respond = maya.page.getByRole("region", { name: "Respond to the author" });
      await respond.getByRole("radio", { name: "Comment" }).check();
      await respond.getByRole("textbox", { name: /Your feedback/ }).fill(text);
      await respond.getByRole("button", { name: "Send to the author" }).click();
      await expect(respond.getByRole("status")).toContainText(`for version ${readVersion}`);

      // Riley sees it, attributed, on the engagement page.
      await riley.page.goto(`${STRATEGY}/engagement`);
      const statements = riley.page.getByRole("region", { name: "Reader statements" });
      const item = statements.getByRole("listitem").filter({ hasText: text });
      await expect(item).toBeVisible();
      await expect(item).toContainText(`Maya Chen · version ${readVersion}`);

      // Riley publishes a clarifying revision.
      await riley.page.goto(`${STRATEGY}/edit`);
      const detail = `A focused team. A defined investment. Stop-or-scale criteria signed off by the Finance lead before day one. (${uid()})`;
      await editAndSave(riley.page, "Detail", detail, "Request");
      await riley.page.goto(`${STRATEGY}/preview`);
      const n = await publishFromPreview(riley.page, "Named who in Finance signs off the stop-or-scale criteria.");
      expect(n).toBeGreaterThan(readVersion);
      await expect(riley.page.getByRole("region", { name: "The decision" })).toContainText("signed off by the Finance lead");

      // Riley marks the feedback resolved, addressed in the new version.
      await riley.page.goto(`${STRATEGY}/engagement`);
      const open = riley.page.getByRole("region", { name: "Reader statements" }).getByRole("listitem").filter({ hasText: text });
      await open.getByRole("combobox", { name: "Status" }).selectOption("resolved");
      await open.getByRole("combobox", { name: "Addressed in" }).selectOption({ label: `Version ${n}` });
      await open.getByRole("button", { name: "Update" }).click();
      // The item leaves the unresolved list (its success message goes with it).
      await expect(open).toBeHidden();

      await riley.page.reload();
      const region = riley.page.getByRole("region", { name: "Reader statements" });
      await expect(region.getByRole("heading", { name: /^Unresolved/ })).toBeVisible();
      await region.locator("summary", { hasText: "Resolved and dismissed" }).click();
      const resolved = region.getByRole("listitem").filter({ hasText: text });
      await expect(resolved).toBeVisible();
      await expect(resolved).toContainText("Resolved");
      const link = resolved.getByRole("link", { name: `version ${n}`, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", `${STRATEGY}/v/${n}`);
      await expect(resolved).toContainText(`Addressed in version ${n}`);

      // Engagement is presented as labelled groups, with small cohorts suppressed.
      await expect(riley.page.getByRole("complementary", { name: "About these numbers" })).toContainText("not comprehension or agreement");
      await expect(riley.page.getByRole("region", { name: "Generated topic summaries" })).toBeVisible();
      const measured = riley.page.getByRole("region", { name: "Measured events" });
      await expect(measured).toBeVisible();
      await expect(measured.getByText("Fewer than 3 readers — hidden for privacy").first()).toBeVisible();
      // Private reader questions never appear here.
      await expect(riley.page.getByText("What net revenue retention do mid-market accounts have?")).toHaveCount(0);
    } finally {
      await maya.context.close();
      await riley.context.close();
    }
  });
});
