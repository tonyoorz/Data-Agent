import { describe, expect, it } from "vitest";
import { computeRuntimeMetrics, deriveIntentUniverse } from "../../../evals/scorecard/metrics.mjs";

function chatRow(overrides = {}) {
  return {
    schemaVersion: "1.0",
    intent: "metric_query",
    outcome: "completed",
    citationValidation: "pass",
    businessRuleCodes: ["planner.approved_metric_only"],
    latencyMs: 1200,
    ...overrides,
  };
}

function testcaseRow(overrides = {}) {
  return {
    schemaVersion: "1.0",
    intent: "create_testcase",
    outcome: "completed",
    generationRounds: 2,
    verificationPassed: true,
    judgeStatus: "pass",
    modelCoveragePct: 100,
    latencyMs: 45000,
    ...overrides,
  };
}

describe("computeRuntimeMetrics with testcase rows", () => {
  it("computes chat metrics over chat rows only — testcase rows do not dilute pass rates", () => {
    const metrics = computeRuntimeMetrics([
      chatRow(),
      chatRow({ citationValidation: "pending", businessRuleCodes: [] }),
      testcaseRow({ verificationPassed: false, judgeStatus: "fail", modelCoveragePct: 40 }),
    ]);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.citation_pass_rate_pct).toBe(50); // 1 of the 2 chat rows, not 1 of 3
    expect(metrics.business_rule_activation_pct).toBe(50);
    expect(metrics.outcome_distribution).toEqual({ completed: 100 }); // all rows completed
  });

  it("aggregates testcase quality from create_testcase rows", () => {
    const metrics = computeRuntimeMetrics([
      chatRow(),
      testcaseRow(),
      testcaseRow({ generationRounds: 4, verificationPassed: false, judgeStatus: "skipped", modelCoveragePct: 60, latencyMs: 90000 }),
      testcaseRow({ verificationPassed: true, judgeStatus: "fail", modelCoveragePct: 80, latencyMs: 60000 }),
    ]);
    const tc = metrics.testcase_quality;
    expect(tc).not.toBeNull();
    expect(tc.count).toBe(3);
    expect(tc.avg_generation_rounds).toBe(2.7); // (2 + 4 + 2) / 3
    expect(tc.verification_pass_rate_pct).toBe(66.7);
    expect(tc.judge_pass_rate_pct).toBe(50); // 1 pass / (3 - 1 skipped)
    expect(tc.judge_skipped_count).toBe(1);
    expect(tc.avg_model_coverage_pct).toBe(80); // (100 + 60 + 80) / 3
    expect(tc.latency_ms.max).toBe(90000);
  });

  it("reports null testcase_quality and null chat rates when only testcase rows exist", () => {
    const metrics = computeRuntimeMetrics([testcaseRow()]);
    expect(metrics.hasData).toBe(true);
    expect(metrics.citation_pass_rate_pct).toBeNull();
    expect(metrics.business_rule_activation_pct).toBeNull();
    expect(metrics.testcase_quality.count).toBe(1);
    expect(metrics.testcase_quality.judge_pass_rate_pct).toBe(100);
  });

  it("returns null testcase_quality when there is no data at all", () => {
    const metrics = computeRuntimeMetrics([]);
    expect(metrics.hasData).toBe(false);
    expect(metrics.testcase_quality).toBeNull();
  });

  it("derives the intent universe from golden cases", () => {
    const universe = deriveIntentUniverse([
      { expected: { intent: "metric_query" } },
      { expected: { intent: "testcase_context" } },
      { expected: { intent: "metric_query" } },
      { expected: {} },
    ]);
    expect([...universe].sort()).toEqual(["metric_query", "testcase_context"]);
  });
});
