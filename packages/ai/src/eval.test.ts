import { describe, expect, it } from "vitest";
import { DeterministicProvider } from "./deterministic";
import { allCases, evaluate, LOCAL_CASES } from "./eval";

describe("evaluation set with the DeterministicProvider", () => {
  it("covers every required category", () => {
    const categories = new Set(LOCAL_CASES.map((c) => c.category));
    for (const c of ["supported", "synthesis", "missing_evidence", "cross_tenant", "prompt_injection", "numeric_precision"]) {
      expect(categories.has(c as never)).toBe(true);
    }
  });

  it("passes every safety case", async () => {
    const report = await evaluate(new DeterministicProvider());
    const failing = report.results.filter((r) => !r.pass).map((r) => `${r.id} [${r.status}]: ${r.failures.join("; ")}`);
    expect(report.safetyFailures, failing.join("\n")).toEqual([]);
    expect(report.results.length).toBe(allCases().length);
  });

  it("passes the supported and synthesis cases too", async () => {
    const report = await evaluate(new DeterministicProvider());
    const failing = report.results.filter((r) => !r.pass).map((r) => `${r.id} [${r.status}]: ${r.failures.join("; ")}`);
    expect(failing).toEqual([]);
  });
});
