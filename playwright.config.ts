import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a live `next dev` server on a dedicated PGlite
 * database (`.data/pglite-e2e`), reset before every run. PGlite is
 * single-process and tests share seeded state, so everything runs on one
 * worker in file order.
 *
 * Run: `npm run test:e2e` (or `npx playwright test`). Requires Chromium at
 * /usr/bin/chromium (override with PLAYWRIGHT_CHROMIUM_PATH).
 */
const repoRoot = resolve(import.meta.dirname);
/** `E2E_PORT` lets parallel checkouts run the suite side by side (default 3400). */
const PORT = Number(process.env.E2E_PORT ?? 3400);
const BASE_URL = `http://localhost:${PORT}`;
const pgliteDir = resolve(repoRoot, ".data", "pglite-e2e");
const objectsDir = resolve(repoRoot, ".data", "objects-e2e");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium";

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
