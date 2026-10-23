import { expect, test } from "@playwright/test";
import { textImage } from "../packages/capture/test/image-fixtures";
import { contextAs, uid } from "./helpers";

test.describe("new brief from an image", () => {
  test.skip(({ isMobile }) => isMobile, "desktop only");

  test("Riley uploads a whiteboard photo; OCR runs in the background and its passages are marked as machine-read", async ({ browser }) => {
    const riley = await contextAs(browser, "riley");
    const title = `Whiteboard notes ${uid()}`;
    const png = Buffer.from(await textImage(["Onboarding time fell to 41 days", "Support load stayed flat"]));
    try {
      const { page } = riley;
      await page.goto("/c/acme/new");
      await page.getByRole("radio", { name: /^Upload a file/ }).check();
      await page.getByRole("textbox", { name: /^Title/ }).fill(title);
      await page.getByLabel(/^File/).setInputFiles({ name: "whiteboard.png", mimeType: "image/png", buffer: png });
      await page.getByRole("button", { name: "Create draft" }).click();
      await page.waitForURL(/\/edit/);

      const sources = page.getByRole("region", { name: "Sources" });
      await expect(sources.getByText("whiteboard.png")).toBeVisible();
      // The panel refreshes itself while extraction runs.
      await expect(sources.getByText("Complete")).toBeVisible({ timeout: 60_000 });
      await expect(sources.getByText(/machine-read by OCR/)).toBeVisible();
      await sources.getByText(/^Passages/).click();
      await expect(sources.getByText(/^Image \(OCR, \d{1,3}% confidence\)$/)).toBeVisible();
      await expect(sources.getByText(/Onboarding time fell to 41 days/i)).toBeVisible();
    } finally {
      await riley.context.close();
    }
  });
});
