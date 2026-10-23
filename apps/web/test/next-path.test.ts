/**
 * Post-sign-in destinations (`?next=`) must stay on this origin. Browsers strip
 * tab, CR and LF from URLs and treat `\` like `/`, so `/<TAB>/evil.example`
 * becomes the protocol-relative `//evil.example` once it reaches `Location`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeNextPath, signInPath } = await import("../lib/auth");

const BASE = "https://cerebro.example";
const resolvesOffOrigin = (path: string) => new URL(path, BASE).origin !== BASE;

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/c/acme/b/plan?x=1#s")).toBe("/c/acme/b/plan?x=1#s");
    expect(safeNextPath("/")).toBe("/");
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    "/\t\\evil.example",
    "\t//evil.example",
    "https://evil.example",
    "/%2F/evil.example".replace("%2F", "\u0000/"),
  ])("refuses %j, which a browser could resolve off-origin", (next) => {
    expect(safeNextPath(next)).toBe("/");
    expect(signInPath(next)).toBe("/sign-in");
  });

  it("never returns a value a browser resolves to another origin", () => {
    const tricky = ["/\t/evil.example", "/ /evil.example", "/\u000b/evil.example", "/x\\..\\..\\/evil.example"];
    for (const t of tricky) expect(resolvesOffOrigin(safeNextPath(t))).toBe(false);
  });
});
