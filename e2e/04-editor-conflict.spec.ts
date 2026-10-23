import { expect, test } from "@playwright/test";
import { PRIVATE_DRAFT_TITLE, contextAs, uid } from "./helpers";

test.describe("editor conflict", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("a save from a stale tab shows the conflict and keeps the author's input", async ({ browser }) => {
    const a = await contextAs(browser, "riley");
    const b = await contextAs(browser, "riley");
    try {
      await a.page.goto("/c/acme/drafts");
      const href = await a.page.getByRole("main").getByRole("link", { name: PRIVATE_DRAFT_TITLE }).first().getAttribute("href");
      const editPath = `${href!.replace(/\/(edit|preview)?(\?.*)?$/, "")}/edit`;

      for (const p of [a.page, b.page]) {
        await p.goto(editPath);
        await expect(p.getByRole("status").filter({ hasText: /All changes saved · draft version \d+/ })).toBeVisible();
      }

      // Both tabs have unsaved edits; A saves first.
      const summaryA = `Tab A summary ${uid()}`;
      const summaryB = `Tab B summary ${uid()}`;
      await b.page.getByRole("textbox", { name: "Summary (required)", exact: true }).fill(summaryB);
      await a.page.getByRole("textbox", { name: "Summary (required)", exact: true }).fill(summaryA);
      await a.page.getByRole("button", { name: "Save draft" }).click();
      await expect(a.page.getByRole("status").filter({ hasText: /^Saved · draft version \d+/ })).toBeVisible();

      // B is based on the older version: never overwrites.
      const saveB = b.page.getByRole("button", { name: "Save draft" });
      const conflict = b.page.getByRole("alert").filter({ hasText: "This draft was changed elsewhere" });
      if (!(await conflict.isVisible())) await saveB.click();
      await expect(conflict).toBeVisible();
      await expect(conflict).toContainText("Nothing was overwritten.");
      await expect(b.page.getByRole("status").filter({ hasText: "Not saved: changed elsewhere" })).toBeVisible();
      await expect(b.page.getByRole("textbox", { name: "Summary (required)", exact: true })).toHaveValue(summaryB);

      // The server kept A's change.
      await a.page.reload();
      await expect(a.page.getByRole("textbox", { name: "Summary (required)", exact: true })).toHaveValue(summaryA);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("invalid input is listed as errors and not saved", async ({ browser }) => {
    const a = await contextAs(browser, "riley");
    try {
      await a.page.goto("/c/acme/drafts");
      const href = await a.page.getByRole("main").getByRole("link", { name: PRIVATE_DRAFT_TITLE }).first().getAttribute("href");
      await a.page.goto(`${href!.replace(/\/(edit|preview)?(\?.*)?$/, "")}/edit`);
      await a.page.getByRole("group", { name: "Basics" }).getByRole("textbox", { name: "Title (required)", exact: true }).fill("");
      await a.page.getByRole("button", { name: "Save draft" }).click();
      const alert = a.page.getByRole("alert").filter({ hasText: "The draft couldn't be saved because it has errors." });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole("listitem").first()).toBeVisible();
      await expect(a.page.getByRole("status").filter({ hasText: /^Not saved$/ })).toBeVisible();
    } finally {
      await a.context.close();
    }
  });
});
