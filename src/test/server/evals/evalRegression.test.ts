// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluateRegression } from "../../../../scripts/evalRegression.mjs";

const baseline = { dataset: "golden-v1.jsonl", anchorAt: "2026-08-16T02:00:00.000Z", total: 50, passed: 11, accuracy: 0.22 };

describe("eval regression gate", () => {
  it("same accuracy → ok", () => {
    const r = evaluateRegression(baseline, { total: 50, passed: 11, accuracy: 0.22 });
    expect(r.ok).toBe(true);
    expect(r.dropPp).toBe(0);
  });

  it("improvement → ok", () => {
    const r = evaluateRegression(baseline, { total: 50, passed: 40, accuracy: 0.8 });
    expect(r.ok).toBe(true);
    expect(r.dropPp).toBeLessThan(0);
  });

  it("small drop within tolerance (<=2pp) → ok", () => {
    // 0.22 → 0.21 is 1pp drop
    const r = evaluateRegression(baseline, { total: 100, passed: 21, accuracy: 0.21 });
    expect(r.ok).toBe(true);
    expect(r.dropPp).toBeCloseTo(1, 5);
  });

  it("drop >2pp → blocked (exit 1 semantics)", () => {
    // 0.22 → 0.19 is 3pp drop
    const r = evaluateRegression(baseline, { total: 100, passed: 19, accuracy: 0.19 });
    expect(r.ok).toBe(false);
    expect(r.dropPp).toBeCloseTo(3, 5);
  });

  it("dataset shrink flagged as failure", () => {
    const r = evaluateRegression(baseline, { total: 10, passed: 10, accuracy: 1.0 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("DATASET_SHRINK");
  });
});
