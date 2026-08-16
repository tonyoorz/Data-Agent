// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEvalRunner } from "../../../../server/agentRuntime/evalRunner.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

const NOW = "2026-08-16T02:00:00.000Z";
const actor = { actorId: "eval", scopeHash: "eval-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };

function buildRunner() {
  const registry = createOntologyRegistry();
  const resolver = createSemanticResolver({ registry, now: () => NOW });
  return createEvalRunner({ registry, resolver, now: () => NOW, actor });
}

const MINI = [
  { id: "mini-1", domain: "defect", intent: "metric_query", q: "上个月 BCM 停演缺陷趋势", expect: { metrics: ["defect.showstopper_count"] } },
  { id: "mini-2", domain: "reject", intent: "out_of_scope", q: "今天天气怎么样", expect: { reject: true } },
  { id: "mini-3", domain: "clarify", intent: "clarification", q: "测试情况如何", expect: { clarify: true } },
  { id: "mini-4", domain: "defect", intent: "metric_query", q: "上个月 BCM 停演缺陷趋势", expect: { metrics: ["defect.count"] } }, // 故意错：应失败
];

describe("eval runner (mini cases)", () => {
  it("scores 3/4 with per-check detail and byIntent aggregation", () => {
    const runner = buildRunner();
    const report = runner.run(MINI);
    expect(report.total).toBe(4);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.accuracy).toBe(0.75);
    expect(report.byIntent.metric_query).toEqual({ pass: 1, fail: 1 });
    expect(report.byIntent.out_of_scope).toEqual({ pass: 1, fail: 0 });
    const failed = report.failures.find((f) => f.id === "mini-4");
    expect(failed).toBeTruthy();
    expect(failed.checks.some((c) => c.name === "metrics" && !c.pass)).toBe(true);
  });

  it("checks time window month when expect.time is YYYY-MM", () => {
    const runner = buildRunner();
    const report = runner.run([
      { id: "t-1", domain: "defect", intent: "metric_query", q: "上个月 BCM 停演缺陷趋势", expect: { metrics: ["defect.showstopper_count"], time: "2026-07" } },
    ]);
    expect(report.passed).toBe(1);
    const t = report.results[0].checks.find((c) => c.name === "time");
    expect(t.pass).toBe(true);
  });

  it("marks case failed when router disagrees with expected intent", () => {
    const runner = buildRunner();
    const report = runner.run([
      { id: "r-1", domain: "reject", intent: "out_of_scope", q: "缺陷按 ECU 分布排名", expect: { reject: true } },
    ]);
    expect(report.passed).toBe(0);
    expect(report.results[0].checks.find((c) => c.name === "route").pass).toBe(false);
  });

  it("report includes leakageGuard flag for A3 wiring", () => {
    const runner = buildRunner();
    const report = runner.run(MINI);
    expect(report.leakageGuard).toBe(true);
  });
});
