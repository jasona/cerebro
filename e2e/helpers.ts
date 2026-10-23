import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** Seeded dev users (packages/database/src/seed.ts). */
export const USERS = {
  riley: "Riley Lee",
  maya: "Maya Chen",
  alex: "Alex Rivera",
  priya: "Priya Shah",
  jordan: "Jordan Ellis",
  sam: "Sam Taylor",
  casey: "Casey Morgan",
  taylor: "Taylor Kim",
} as const;
export type UserKey = keyof typeof USERS;

export const BASE_URL = "http://localhost:3400";
export const STRATEGY = "/c/acme/b/our-next-chapter-a-focused-move-upmarket";
export const STRATEGY_TITLE = "Our next chapter: a focused move upmarket.";
export const TEAM_PLAN_TITLE = "Platform readiness for the mid-market pilot";
export const PRIVATE_DRAFT_TITLE = "Pricing simplification (working draft)";
export const PLATFORM_TEAM = "/c/acme/d/product/t/platform";

/** Unique suffix so reruns against the same server never collide. */
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Sign in through the dev picker (AUTH_MODE=dev). Leaves the page wherever the picker redirects. */
export async function signInAs(page: Page, user: UserKey, next = "/"): Promise<void> {
  await page.goto(`/dev/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByRole("button", { name: `Sign in as ${USERS[user]}`, exact: false }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dev/sign-in"));
}

/** A fresh browser context signed in as `user`, for multi-user and multi-tab scenarios. */
export async function contextAs(browser: Browser, user: UserKey, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, ...options });
  const page = await context.newPage();
  await signInAs(page, user);
  return { context, page };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The library link to a brief. Its accessible name is the title, optionally
 * followed by a read-state suffix (", Unread", ", Updated since you read it").
 */
export function briefLink(scope: Page | Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp(`^${escapeRe(title)}(\\s*,.*)?$`) });
}

/** Version number shown in the reader's byline ("… Updated <date> Version N View changes"). */
export async function readerVersion(page: Page): Promise<number> {
  const byline = page.getByRole("main").getByRole("article").first().locator("p").filter({ hasText: /\bVersion \d+/ }).first();
  const m = /\bVersion (\d+)/.exec(await byline.innerText());
  if (!m) throw new Error("no version in the reader byline");
  return Number(m[1]);
}

/** Wait for client components to hydrate (the reader and editor are interactive). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

/**
 * Edit a field in the editor (optionally inside a named fieldset), save,
 * and wait for the saved status.
 */
export async function editAndSave(page: Page, label: string, value: string, group?: string): Promise<void> {
  const scope = group ? page.getByRole("group", { name: group, exact: true }) : page;
  const field = scope.getByRole("textbox", { name: label, exact: true });
  await expect(field).toBeVisible();
  await field.fill(value);
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved · draft version \d+/ })).toBeVisible();
}

/** From /preview: publish and return the version number from the "Published version N" banner. */
export async function publishFromPreview(page: Page, changeSummary?: string): Promise<number> {
  // "Publish" for a first publication, "Publish version N" afterwards.
  const publish = page.getByRole("button", { name: /^Publish( version \d+)?$/ });
  await expect(publish).toBeVisible();
  const n = Number(/(\d+)/.exec(await publish.innerText())?.[1] ?? 1);
  if (changeSummary !== undefined) await page.getByRole("textbox", { name: "Change summary for readers" }).fill(changeSummary);
  await publish.click();
  await page.waitForURL((u) => u.searchParams.get("published") === String(n));
  await expect(page.getByRole("status").filter({ hasText: `Published version ${n}.` })).toBeVisible();
  return n;
}
