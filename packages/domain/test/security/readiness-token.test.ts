/**
 * `/api/ready` internal token (T28). The comparison must not return early on
 * a length mismatch: that is a timing oracle for the token's length. Both
 * sides are hashed to a fixed length and always compared in constant time.
 */
import { describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { isInternalReadinessCaller } = await import("../../src/ops/health");

const TOKEN = "internal-probe-token-123";
const env = { READINESS_TOKEN: TOKEN };
const req = (auth?: string) => new Request("http://x/api/ready", auth ? { headers: { authorization: auth } } : {});

describe("readiness token comparison", () => {
  it("accepts only the exact token", () => {
    expect(isInternalReadinessCaller(req(`Bearer ${TOKEN}`), env)).toBe(true);
    expect(isInternalReadinessCaller(req(`Bearer ${TOKEN}x`), env)).toBe(false);
    expect(isInternalReadinessCaller(req(`Bearer ${TOKEN.slice(0, -1)}`), env)).toBe(false);
    expect(isInternalReadinessCaller(req(), env)).toBe(false);
    expect(isInternalReadinessCaller(req(`Bearer ${TOKEN}`), {})).toBe(false);
  });

  it("compares in constant time even when the lengths differ", () => {
    spy.calls = 0;
    expect(isInternalReadinessCaller(req("Bearer x"), env)).toBe(false);
    expect(isInternalReadinessCaller(req(`Bearer ${"y".repeat(500)}`), env)).toBe(false);
    expect(spy.calls).toBe(2);
  });
});
