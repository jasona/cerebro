/**
 * Clerk middleware configuration (D08). Clerk session tokens carry the
 * frontend origin that minted them (`azp`); without `authorizedParties` Clerk
 * accepts a session token minted by any application on the same Clerk
 * instance, including one sent as a bearer header from another origin.
 */
import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ clerkMiddleware: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => clerk);

const saved = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  clerk.clerkMiddleware.mockReset();
  clerk.clerkMiddleware.mockReturnValue(() => undefined);
});
afterEach(() => {
  process.env = { ...saved };
});

async function runProxy(path = "/c/acme") {
  const { proxy } = await import("../proxy");
  await proxy(new NextRequest(`https://cerebro.example${path}`), {} as NextFetchEvent);
}

describe("proxy (AUTH_MODE=clerk)", () => {
  it("binds Clerk session tokens to the APP_URL origin", async () => {
    process.env = { ...saved, AUTH_MODE: "clerk", APP_URL: "https://cerebro.example/" };
    await runProxy();
    expect(clerk.clerkMiddleware).toHaveBeenCalledTimes(1);
    expect(clerk.clerkMiddleware.mock.calls[0]![0]).toMatchObject({ authorizedParties: ["https://cerebro.example"] });
  });

  it("does not load Clerk for the MCP endpoint or OAuth metadata", async () => {
    process.env = { ...saved, AUTH_MODE: "clerk", APP_URL: "https://cerebro.example" };
    await runProxy("/api/mcp");
    await runProxy("/.well-known/oauth-protected-resource/api/mcp");
    expect(clerk.clerkMiddleware).not.toHaveBeenCalled();
  });

  it("does not load Clerk for the health and readiness probes", async () => {
    process.env = { ...saved, AUTH_MODE: "clerk", APP_URL: "https://cerebro.example" };
    await runProxy("/api/health");
    await runProxy("/api/ready");
    expect(clerk.clerkMiddleware).not.toHaveBeenCalled();
    await runProxy("/api/healthz");
    expect(clerk.clerkMiddleware).toHaveBeenCalledTimes(1);
  });

  it("is a pass-through in dev mode", async () => {
    process.env = { ...saved, AUTH_MODE: "dev", NODE_ENV: "test" };
    await runProxy();
    expect(clerk.clerkMiddleware).not.toHaveBeenCalled();
  });
});
