import { expect, test, type Locator, type Page } from "@playwright/test";
import { STRATEGY, readerVersion, signInAs, uid } from "./helpers";

/**
 * Ask a question in the given Ask panel and wait for a grounded answer.
 * Q&A depends on the in-process indexing job, so while the version is still
 * "being prepared" the question is asked again (up to ~45s).
 */
async function askUntilAnswered(panel: Locator, question: string): Promise<Locator> {
  const deadline = Date.now() + 45_000;
  for (let attempt = 0; ; attempt++) {
    const input = panel.getByRole("textbox", { name: /Ask a (question about this briefing|follow-up)/ });
    await input.fill(question);
    await panel.getByRole("button", { name: "Ask", exact: true }).click();
    const exchange = panel.getByRole("list", { name: "This conversation" }).locator(":scope > li").last();
    await expect(exchange.getByText(/Finding an answer/)).toHaveCount(0, { timeout: 30_000 });
    await expect(exchange.getByText(/Grounded in version \d+|Q&A is being prepared|doesn't answer|can't be answered|unavailable/).first()).toBeVisible();
    if (await exchange.getByText(/Grounded in version \d+/).isVisible()) return exchange;
    const preparing = await exchange.getByText("Q&A is being prepared for this version").isVisible();
    if (!preparing) throw new Error(`question was not answered: ${await exchange.innerText()}`);
    if (Date.now() > deadline) throw new Error("Q&A stayed in 'preparing' for too long");
    await panel.page().waitForTimeout(2_000);
  }
}

async function openStrategy(page: Page) {
  await signInAs(page, "maya");
  await page.goto(STRATEGY);
  await expect(page.getByRole("region", { name: "The decision" })).toBeVisible();
}

test.describe("reader (desktop)", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("position, outline, perspective, evidence marker, ask, previous questions and feedback", async ({ page }) => {
    await openStrategy(page);
    const n = await readerVersion(page);

    // Position and requested decision lead the page.
    const decision = page.getByRole("region", { name: "The decision" });
    await expect(decision).toBeVisible();
    await expect(decision).toContainText("Approve a 90-day mid-market pilot.");
    await expect(page.getByRole("region", { name: "Why it matters" })).toBeVisible();

    // Outline.
    const outline = page.getByRole("navigation", { name: "In this briefing" });
    await expect(outline.getByRole("link", { name: "The evidence" })).toHaveAttribute("href", "#sec_evidence");

    // Perspective switch.
    const perspectives = page.getByRole("navigation", { name: "Perspective" });
    await perspectives.getByRole("link", { name: "Finance" }).click();
    await page.waitForURL(/perspective=psp_finance/);
    await expect(page.getByText("Budget exposure is bounded to the pod's cost for 90 days").first()).toBeVisible();
    await perspectives.getByRole("link", { name: "Overview" }).click();
    await page.waitForURL((u) => !u.searchParams.has("perspective"));

    // An evidence marker opens the Evidence tab with the excerpt.
    const explore = page.getByRole("complementary", { name: "Explore this briefing" });
    await page.getByRole("link", { name: "Evidence 1: Customer cohort analysis" }).first().click();
    await expect(explore.getByRole("tab", { name: /^Evidence/ })).toHaveAttribute("aria-selected", "true");
    await expect(explore.getByRole("tabpanel")).toContainText("124% net revenue retention");

    // "Ask about this" switches to Ask, scoped to the block.
    await page.getByRole("link", { name: "Ask about this: Approve a 90-day mid-market pilot." }).click();
    await expect(explore.getByRole("tab", { name: "Ask" })).toHaveAttribute("aria-selected", "true");
    await expect(explore.getByText(/^About: .*Approve a 90-day mid-market pilot\./).first()).toBeVisible();
    await expect(explore.getByRole("textbox", { name: "Ask a question about this briefing" })).toBeFocused();
    await explore.getByRole("link", { name: "Ask about the whole briefing" }).click();
    await expect(explore.getByText("About: the whole briefing")).toBeVisible();

    // A grounded answer with citations, bound to the version on screen.
    const question = `What net revenue retention do mid-market accounts have? (${uid()})`;
    const answer = await askUntilAnswered(explore, question);
    await expect(answer.getByText(`Grounded in version ${n}`)).toBeVisible();
    await expect(answer.getByText(/Stated in the briefing|Inferred/).first()).toBeVisible();
    await expect(answer.getByRole("link", { name: /^Source \d+: / }).first()).toBeVisible();
    await expect(answer.getByText("Sources in this version")).toBeVisible();

    // After a reload the conversation appears under previous questions.
    await page.reload();
    const history = explore.getByRole("region", { name: `Your previous questions on version ${n}` });
    await expect(history).toBeVisible();
    await expect(history.locator("summary").filter({ hasText: question })).toBeVisible();

    // Attributed feedback requires an explicit submission.
    const respond = page.getByRole("region", { name: "Respond to the author" });
    await respond.getByRole("radio", { name: "Concern" }).check();
    await respond.getByRole("combobox", { name: "About" }).selectOption({ label: "The recommendation: Approve a 90-day mid-market pilot." });
    await respond.getByRole("textbox", { name: /Your feedback/ }).fill(`Reader test concern ${uid()}`);
    await respond.getByRole("button", { name: "Send to the author" }).click();
    await expect(respond.getByRole("status")).toContainText(`Sent to the author with your name, for version ${n}.`);
  });

  test("a pinned older version shows the older-version banner", async ({ page }) => {
    await openStrategy(page);
    await page.goto(`${STRATEGY}/v/1`);
    const note = page.getByRole("note").filter({ hasText: "You're reading version 1" });
    await expect(note).toBeVisible();
    await expect(note).toContainText(/A newer version \(\d+\) is available/);
    await note.getByRole("link", { name: "Read the latest version" }).click();
    await page.waitForURL((u) => u.pathname === STRATEGY);
    await expect(page.getByRole("note").filter({ hasText: "You're reading version" })).toHaveCount(0);
  });
});

test.describe("reader (mobile)", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the Ask/Evidence bottom bar opens sheets", async ({ page }) => {
    await openStrategy(page);
    // No sticky side panel on a phone.
    await expect(page.getByRole("complementary", { name: "Explore this briefing" })).toHaveCount(0);

    await page.getByRole("button", { name: /^Evidence \(\d+\)$/ }).click();
    const sheet = page.getByRole("dialog", { name: "Explore this briefing" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("tab", { name: /^Evidence/ })).toHaveAttribute("aria-selected", "true");
    await expect(sheet.getByText("Customer cohort analysis").first()).toBeVisible();
    await sheet.getByRole("button", { name: "← Back to the briefing" }).click();
    await expect(sheet).toBeHidden();

    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("tab", { name: "Ask" })).toHaveAttribute("aria-selected", "true");
    await expect(sheet.getByRole("textbox", { name: "Ask a question about this briefing" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // An inline evidence marker also opens the sheet on the Evidence tab.
    await page.getByRole("link", { name: "Evidence 2: Implementation review" }).first().click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("tab", { name: /^Evidence/ })).toHaveAttribute("aria-selected", "true");
  });
});
