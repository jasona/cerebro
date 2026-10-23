import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a live `next dev` server on a dedicated PGlite
 * database (`.data/pglite-e2e`), reset before every run. PGlite is
 * single-process and tests share seeded state, so everything runs on one
 * worker in file order.
 *
 * Run: `npm run test:e2e` (or `npx playwright test`). Uses Chromium at
 * PLAYWRIGHT_CHROMIUM_PATH, else /usr/bin/chromium when present, else
 * Playwright's bundled Chromium (`npx playwright install chromium`).
 * E2E_PORT overrides the port (default 3400). With DATABASE_URL set, the
 * server and the reset run against that PostgreSQL database instead.
 */
const repoRoot = resolve(import.meta.dirname);
const PORT = Number(process.env.E2E_PORT ?? 3400);
const BASE_URL = `http://localhost:${PORT}`;
const pgliteDir = resolve(repoRoot, ".data", "pglite-e2e");
const objectsDir = resolve(repoRoot, ".data", "objects-e2e");
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } },
    },
    {
      name: "mobile",
      // Mobile runs only the specs that exercise responsive behavior.
      testMatch: /(reader|a11y)\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        launchOptions: { executablePath },
      },
    },
  ],
  // E2E_EXTERNAL_SERVER=1 reuses a server you started yourself (same env as below).
  webServer: process.env.E2E_EXTERNAL_SERVER
    ? undefined
    : {
    command: `npm run db:reset && npm exec -w @cerebro/web -- next dev -p ${PORT}`,
    cwd: repoRoot,
    url: `${BASE_URL}/dev/sign-in`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      CEREBRO_PGLITE_DIR: pgliteDir,
      CEREBRO_OBJECTS_DIR: objectsDir,
      AUTH_MODE: "dev",
      APP_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
