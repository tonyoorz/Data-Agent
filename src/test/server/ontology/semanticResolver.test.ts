// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

const anchorAt = "2026-07-15T04:00:00.000Z";
const actor = {
  actorId: "alice",
  scopeHash: "scope-a",
  scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] },
};

const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => anchorAt });

describe("Ontology semantic resolver", () => {
  it.each([
    ["2026 年 DTSV 有多少缺陷？", "aggregate", "defect.count", null, "2026-01-01"],
    ["2026 年 6 月 DTSV 创建了多少缺陷？", "aggregate", "defect.created_count", null, "2026-06-01"],
    ["六月新增缺陷按 ECU 统计", "aggregate", "defect.created_count", "product.ecu", "2026-06-01"],
    ["最近一周 Top 5 高频模块", "rank", "defect.created_count", "product.ecu", "2026-07-09"],
    ["OS8 与 OS9 缺陷数对比", "compare", "defect.count", "product.os", "2026-01-01"],
    ["本月测试执行数", "aggregate", "testing.run_count", null, "2026-07-01"],
    ["测试用例数按 PU", "aggregate", "testing.testcase_count", "product.pu", null],
    ["上周通过的测试数", "aggregate", "testing.passed_run_count", null, "2026-07-06"],
    ["给蓝牙断连缺陷做查重", "similarity", null, null, null],
    ["追溯 Requirement 到 TestCase、TestRun 和 Defect", "trace", null, null, "2026-01-01"],
    ["今年 DTSV 的新增缺陷按 ECU 排名", "rank", "defect.created_count", "product.ecu", "2026-01-01"],
  ])("resolves a governed business question: %s", (query, intent, metricId, dimensionId, start) => {
    const frame = resolver.resolve({ query, actor, requestAnchorAt: anchorAt });

    expect(frame.intent).toBe(intent);
    if (metricId) expect(frame.metricIds).toContain(metricId);
    if (dimensionId) expect(frame.dimensionIds).toContain(dimensionId);
    if (start) expect(frame.timeScopes[0].start).toBe(start);
    if (frame.entityIds.includes("quality.defect") && frame.intent !== "trace") {
      expect(frame.filters).toContainEqual({ dimensionId: "org.problem_finder_team", operator: "in", values: ["DTSV_China"], source: "policy" });
    }
    if (frame.entityIds.includes("testing.test_run")) {
      expect(frame.filters).toContainEqual({ dimensionId: "org.team", operator: "in", values: ["DTSV_China"], source: "policy" });
    }
  });

  it("is deterministic for the same question and anchor", () => {
    const input = { query: "最近两周 DTSV 新增缺陷按 ECU Top 10", actor, requestAnchorAt: anchorAt };
    expect(resolver.resolve(input)).toEqual(resolver.resolve(input));
  });

  it("unions same-dimension comparison values instead of intersecting them", () => {
    const frame = resolver.resolve({ query: "OS8 与 OS9 缺陷数对比", actor, requestAnchorAt: anchorAt });
    expect(frame.filters.filter((item) => item.dimensionId === "product.os" && item.source === "user")).toEqual([
      { dimensionId: "product.os", operator: "in", values: ["OS8", "OS9"], source: "user" },
    ]);
    expect(frame.comparison).toEqual({ kind: "dimension_values", dimensionId: "product.os", groups: ["OS8", "OS9"] });
  });

  it("materializes a governed time dimension for trends", () => {
    const frame = resolver.resolve({ query: "OS9 最近三个月新增缺陷趋势", actor, requestAnchorAt: anchorAt });

    expect(frame).toMatchObject({
      intent: "trend",
      metricIds: ["defect.created_count"],
      dimensionIds: ["time.defect_creation_date"],
      timeScopes: [{ start: "2026-05-01", end: "2026-07-15" }],
      sort: [{ fieldId: "time.defect_creation_date", direction: "asc" }],
      limit: 200,
    });
    expect(frame.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS9"], source: "user" });
  });

  it("preserves OS groups while comparing their trends", () => {
    const frame = resolver.resolve({ query: "OS9 和 OS8 最近三个月新增缺陷趋势有什么差异？", actor, requestAnchorAt: anchorAt });

    expect(frame).toMatchObject({
      intent: "compare",
      metricIds: ["defect.created_count"],
      dimensionIds: ["product.os", "time.defect_creation_date"],
      comparison: { kind: "dimension_values", dimensionId: "product.os", groups: ["OS8", "OS9"] },
      sort: [{ fieldId: "time.defect_creation_date", direction: "asc" }],
      limit: 200,
    });
  });

  it("extracts Ontology-declared dynamic PU values as filters", () => {
    const filtered = resolver.resolve({ query: "25-07 PU 当前缺陷数量是多少？", actor, requestAnchorAt: anchorAt });
    const compared = resolver.resolve({ query: "PU 25-03 与 25-07 缺陷数比较", actor, requestAnchorAt: anchorAt });

    expect(filtered.dimensionIds).toEqual([]);
    expect(filtered.filters).toContainEqual({ dimensionId: "product.pu", operator: "in", values: ["25-07"], source: "user" });
    expect(compared).toMatchObject({
      intent: "compare",
      dimensionIds: ["product.pu"],
      comparison: { kind: "dimension_values", dimensionId: "product.pu", groups: ["25-03", "25-07"] },
    });
  });

  it("clarifies a governed metric when its source lacks the requested filter", () => {
    const frame = resolver.resolve({ query: "OS9 最近四周失败 Run 数量是多少？", actor, requestAnchorAt: anchorAt });

    expect(frame.metricIds).toEqual(["testing.failed_run_count"]);
    expect(frame.ambiguities).toContainEqual(expect.objectContaining({ code: "FILTER_DIMENSION_NOT_AVAILABLE", dimensionId: "product.os", options: ["补充其他明确口径", "取消本次查询"] }));
  });

  it("recognizes natural-language rank limits and resolution-speed ambiguity", () => {
    expect(resolver.resolve({ query: "缺陷最多的五个项目是什么？", actor, requestAnchorAt: anchorAt })).toMatchObject({ intent: "rank", limit: 5 });
    const unresolved = resolver.resolve({ query: "解决得快不快？", actor, requestAnchorAt: anchorAt });
    const clarified = resolver.resolve({ query: "解决得快不快？", actor, requestAnchorAt: anchorAt, clarification: { selection: "补充其他明确口径", text: "当前缺陷数量" } });
    expect(unresolved.ambiguities).toContainEqual(expect.objectContaining({ code: "DEFECT_AGE_RULE_UNAPPROVED", options: ["补充其他明确口径", "取消本次查询"] }));
    expect(clarified.metricIds).toEqual(["defect.count"]);
    expect(clarified.ambiguities).toEqual([]);
  });

  it("routes multi-entity lineage questions to traceability", () => {
    const missingSubject = resolver.resolve({ query: "这个 AIDA Requirement 有哪些 TestCase 和最近的 TestRun？", actor, requestAnchorAt: anchorAt });
    const failedRunTrace = resolver.resolve({ query: "失败 Run 关联了哪些 Defect？", actor, requestAnchorAt: anchorAt });

    expect(missingSubject).toMatchObject({ intent: "trace", metricIds: [], dimensionIds: [] });
    expect(missingSubject.ambiguities).toContainEqual(expect.objectContaining({ code: "TRACE_SUBJECT_REQUIRED", options: ["补充其他明确口径", "查看当前授权范围的追溯概览", "取消本次查询"] }));
    expect(failedRunTrace).toMatchObject({ intent: "trace", metricIds: [], dimensionIds: [] });
    expect(failedRunTrace.filters).toContainEqual({ dimensionId: "testing.run_status", operator: "in", values: ["Failed"], source: "user" });

    const scoped = resolver.resolve({ query: "这个 AIDA Requirement 有哪些 TestCase 和最近的 TestRun？", actor, requestAnchorAt: anchorAt, clarification: { selection: "补充其他明确口径", text: "AIDA 标识：REQ-42" } });
    expect(scoped.ambiguities).toEqual([]);
    expect(scoped.filters).toContainEqual({ dimensionId: "requirements.aida", operator: "in", values: ["REQ-42"], source: "user" });

    const overview = resolver.resolve({ query: "这个 AIDA Requirement 有哪些 TestCase 和最近的 TestRun？", actor, requestAnchorAt: anchorAt, clarification: { selection: "查看当前授权范围的追溯概览" } });
    expect(overview.ambiguities).toEqual([]);
  });

  it("models untraced test cases as a governed trace-status filter", () => {
    const frame = resolver.resolve({ query: "哪些 TestCase 没有 Requirement traceability？", actor, requestAnchorAt: anchorAt });

    expect(frame).toMatchObject({ intent: "trace", metricIds: [], dimensionIds: [], timeScopes: [] });
    expect(frame.filters).toContainEqual({ dimensionId: "testing.trace_status", operator: "in", values: ["Untraced"], source: "user" });
  });

  it("infers Ontology-declared PU value patterns for a governed comparison", () => {
    const frame = resolver.resolve({ query: "25-03 与 25-07 的测试通过率比较。", actor, requestAnchorAt: anchorAt });

    expect(frame).toMatchObject({
      intent: "compare",
      metricIds: ["testing.pass_rate"],
      dimensionIds: ["product.pu"],
      comparison: { kind: "dimension_values", dimensionId: "product.pu", groups: ["25-03", "25-07"] },
    });
    expect(frame.filters).toContainEqual({ dimensionId: "product.pu", operator: "in", values: ["25-03", "25-07"], source: "user" });
    expect(frame.ambiguities).toContainEqual(expect.objectContaining({ code: "TEST_RUN_DENOMINATOR_UNAPPROVED" }));
    expect(frame.ambiguities).not.toContainEqual(expect.objectContaining({ code: "COMPARISON_GROUPS_REQUIRED" }));
  });

  it("asks which governed coverage population the user means", () => {
    const frame = resolver.resolve({ query: "覆盖率怎么样？", actor, requestAnchorAt: anchorAt });

    expect(frame.ambiguities).toContainEqual(expect.objectContaining({
      code: "COVERAGE_POPULATION_UNAPPROVED",
      message: expect.stringMatching(/Requirement coverage.*TestCase coverage.*Run coverage.*Traceability coverage/),
    }));
  });

  it("materializes two governed periods for time comparisons", () => {
    const frame = resolver.resolve({ query: "本周比上周新增缺陷增加多少", actor, requestAnchorAt: anchorAt });

    expect(frame).toMatchObject({
      intent: "compare",
      metricIds: ["defect.created_count"],
      dimensionIds: ["time.defect_creation_date"],
      comparison: {
        kind: "time_periods",
        dimensionId: "time.defect_creation_date",
        groups: ["2026-07-06/2026-07-12", "2026-07-13/2026-07-15"],
      },
      sort: [{ fieldId: "time.defect_creation_date", direction: "asc" }],
    });
    expect(frame.timeScopes).toMatchObject([
      { role: "baseline", start: "2026-07-06", end: "2026-07-12" },
      { role: "comparison", start: "2026-07-13", end: "2026-07-15" },
    ]);
  });

  it("turns unapproved metric definitions into focused ambiguities", () => {
    const frame = resolver.resolve({ query: "DTSV 的缺陷密度是多少", actor, requestAnchorAt: anchorAt });
    expect(frame.metricIds).toContain("quality.defect_density");
    expect(frame.ambiguities).toContainEqual(expect.objectContaining({ code: "DEFECT_DENSITY_DENOMINATOR_REQUIRED", kind: "metric_definition" }));
  });

  it("rejects a dimension that the governed metric does not allow", () => {
    expect(() => resolver.resolve({ query: "测试执行数按 ECU", actor, requestAnchorAt: anchorAt })).toThrow("SEMANTIC_DIMENSION_NOT_ALLOWED");
  });

  it("maps DTSV to the executable team dimension for test-run questions", () => {
    const frame = resolver.resolve({ query: "DTSV 本月测试执行数", actor, requestAnchorAt: anchorAt });
    expect(frame.filters).toContainEqual({ dimensionId: "org.team", operator: "in", values: ["DTSV_China"], source: "user" });
    expect(frame.filters).not.toContainEqual(expect.objectContaining({ dimensionId: "org.problem_finder_team" }));
  });

  it("inherits only validated semantic context across elliptical follow-ups", () => {
    const os9 = resolver.resolve({ query: "OS9 上月缺陷数？", actor, requestAnchorAt: anchorAt });
    const os8 = resolver.resolve({ query: "那 OS8 呢？", actor, requestAnchorAt: anchorAt, priorSemanticFrame: os9 });
    const ranked = resolver.resolve({ query: "按 ECU 排名前五。", actor, requestAnchorAt: anchorAt, priorSemanticFrame: os8 });

    expect(os8).toMatchObject({ intent: "aggregate", metricIds: ["defect.count"], timeScopes: [{ start: "2026-06-01", end: "2026-06-30" }] });
    expect(os8.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS8"], source: "user" });
    expect(os8.filters).not.toContainEqual(expect.objectContaining({ dimensionId: "product.os", values: ["OS9"] }));
    expect(ranked).toMatchObject({ intent: "rank", metricIds: ["defect.count"], dimensionIds: ["product.ecu"], limit: 5, timeScopes: [{ start: "2026-06-01", end: "2026-06-30" }] });
    expect(ranked.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS8"], source: "context" });
    expect(ranked.assumptions).toContain("THREAD_SEMANTIC_CONTEXT_INHERITED");
  });

  it("does not inherit an incompatible entity or filter when a follow-up names a new metric", () => {
    const defects = resolver.resolve({ query: "OS9 上月缺陷数？", actor, requestAnchorAt: anchorAt });
    const runs = resolver.resolve({ query: "那测试执行数呢？", actor, requestAnchorAt: anchorAt, priorSemanticFrame: defects });

    expect(runs.metricIds).toEqual(["testing.run_count"]);
    expect(runs.entityIds).toContain("testing.test_run");
    expect(runs.entityIds).not.toContain("quality.defect");
    expect(runs.filters).not.toContainEqual(expect.objectContaining({ dimensionId: "product.os" }));
  });

  it("surfaces an unmatched signal when a metric-bearing query hits no governed term", () => {
    const calls = [];
    const spyingResolver = createSemanticResolver({ registry, now: () => anchorAt, onUnmatched: (signal) => calls.push(signal) });
    const frame = spyingResolver.resolve({ query: "各楼层工位利用率", actor, requestAnchorAt: anchorAt });

    expect(frame.intent).toBe("aggregate");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ intent: "aggregate", heuristicMetric: "defect.count" });
    expect(calls[0].query).toBe("各楼层工位利用率");
  });

  it("does not surface an unmatched signal for a query that matches a governed term", () => {
    const calls = [];
    const spyingResolver = createSemanticResolver({ registry, now: () => anchorAt, onUnmatched: (signal) => calls.push(signal) });
    spyingResolver.resolve({ query: "上周缺陷数是多少", actor, requestAnchorAt: anchorAt });

    expect(calls).toHaveLength(0);
  });
});
