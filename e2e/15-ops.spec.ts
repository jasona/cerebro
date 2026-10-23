import { expect, test } from "@playwright/test";

test.describe("operational endpoints", () => {
  test("liveness and summarized readiness are public; details need the internal token", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ready = await request.get("/api/ready");
    expect(ready.status()).toBe(200);
    expect(ready.headers()["cache-control"]).toContain("no-store");
    // No READINESS_TOKEN is configured for the test server: summary only.
    expect(await ready.json()).toEqual({ status: "ready", failing: [] });
  });
});
