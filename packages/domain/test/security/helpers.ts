/**
 * Shared helpers for the security regression suites. Everything goes through
 * the real domain services under the runtime role; the system context is used
 * only to inspect state or to simulate out-of-band changes.
 */
import { withSystemContext, type Tx } from "@cerebro/database";
import { expect } from "vitest";
import { DomainError } from "../../src/errors";
import { runJobsOnce } from "../../src/jobs/runner";
import type { TestWorld } from "../../src/testing";

export async function expectCode(p: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error(`expected DomainError ${code}`);
}

export const sys = <T>(w: TestWorld, fn: (tx: Tx) => Promise<T>) => withSystemContext(w.h.db, fn);

/** Drain all runnable jobs. */
export async function drain(w: TestWorld): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await runJobsOnce(w.h.db, { workerId: "security-test-worker", limit: 10 });
    if (res.claimed === 0) return;
  }
}

export const NRR_QUESTION = "What net revenue retention did mid-market accounts record?";
