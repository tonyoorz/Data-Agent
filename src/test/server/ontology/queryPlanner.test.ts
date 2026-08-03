// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";
import { createQueryPlanner } from "../../../../server/ontology/queryPlanner.mjs";

const anchorAt = "2026-07-15T04:00:00.000Z";
const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => anchorAt });
const planner = createQueryPlanner({ registry });

describe("Ontology query planner", () => {
  it("deterministically compiles an approved metric frame to one semantic tool step", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const first = planner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });
    const second = planner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "valid", actorScopeHash: "scope-a" });
    expect(first.steps[0]).toMatchObject({
      operation: "semantic_metric_query",
      toolName: "query_semantic_metrics",
      metricIds: ["defect.created_count"],
      dimensionIds: expect.arrayContaining(["product.ecu"]),
      riskLevel: "R0",
    });
  });

  it("does not plan a draft metric before clarification", () => {
    const frame = resolver.resolve({ query: "缺陷密度", actor });
    const plan = planner.createPlan({ frame, actor, query: "缺陷密度" });
    expect(plan.status).toBe("needs_clarification");
    expect(plan.steps).toEqual([]);
    expect(plan.violations).toContain("DEFECT_DENSITY_DENOMINATOR_REQUIRED");
  });

  it("splits multiple approved metrics into deterministic dependent steps", () => {
    const frame = resolver.resolve({
      query: "今年缺陷总数和新增缺陷数",
      actor,
      candidate: { intent: "aggregate", entityIds: ["quality.defect"], metricIds: ["defect.count", "defect.created_count"], dimensionIds: [] },
    });
    const plan = planner.createPlan({ frame, actor, query: "今年缺陷总数和新增缺陷数" });

    expect(plan.steps).toMatchObject([
      { stepId: "s1", metricIds: ["defect.created_count"], dependsOn: [] },
      { stepId: "s2", metricIds: ["defect.count"], dependsOn: ["s1"] },
    ]);
    expect(plan.steps.map((step) => step.canonicalArgs.query.metricIds)).toEqual([["defect.created_count"], ["defect.count"]]);
  });

  it("rejects removal of an actor policy filter", () => {
    const frame = resolver.resolve({ query: "2026 年缺陷数", actor });
    const tampered = { ...frame, filters: frame.filters.filter((filter) => filter.source !== "policy") };
    expect(() => planner.createPlan({ frame: tampered, actor, query: "2026 年缺陷数" })).toThrow("SEMANTIC_POLICY_FILTER_REQUIRED");
  });

  it("requires the test-run team policy dimension instead of the defect-team dimension", () => {
    const frame = resolver.resolve({ query: "本月测试执行数", actor });
    expect(frame.filters).toContainEqual(expect.objectContaining({ source: "policy", dimensionId: "org.team" }));
    const tampered = { ...frame, filters: frame.filters.filter((filter) => filter.dimensionId !== "org.team") };
    expect(() => planner.createPlan({ frame: tampered, actor, query: "本月测试执行数" })).toThrow("SEMANTIC_POLICY_FILTER_REQUIRED:org.team");
  });

  it("routes trace and similarity intents only to their typed tools", () => {
    const traceFrame = resolver.resolve({ query: "追溯 Requirement 到 Defect", actor });
    const similarityFrame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    expect(planner.createPlan({ frame: traceFrame, actor, query: "追溯 Requirement 到 Defect" }).steps[0].toolName).toBe("query_traceability");
    expect(planner.createPlan({ frame: similarityFrame, actor, query: "蓝牙断连缺陷查重" }).steps[0].toolName).toBe("search_duplicates");
  });

  it("plans direct record lists with governed fields and pagination defaults", () => {
    const frame = resolver.resolve({ query: "DTSV 本月缺陷明细列表", actor });
    const plan = planner.createPlan({ frame, actor, query: "DTSV 本月缺陷明细列表" });

    expect(plan.steps[0]).toMatchObject({
      operation: "semantic_record_query",
      toolName: "query_semantic_records",
      canonicalArgs: {
        ontology_version: "v1",
        schema_fingerprint: registry.fingerprint,
        query: expect.objectContaining({ intent: "list", entityIds: ["quality.defect"] }),
        analysis_ref: null,
        selections: [],
        fields: ["defect_id", "name", "status", "assigned_ecu", "problem_finder_team", "creation_time"],
        page: 1,
        page_size: 20,
      },
    });
  });

  it("enforces Ontology capability and query-limit records at plan time", () => {
    const frame = resolver.resolve({ query: "2026 年缺陷数", actor });
    const limitedRegistry = {
      ...registry,
      getConstraint(id: string) {
        if (id === "query.max_limit") return { parameters: { maximum: frame.limit - 1 } };
        return registry.getConstraint(id);
      },
    };
    expect(() => createQueryPlanner({ registry: limitedRegistry }).createPlan({ frame, actor, query: "2026 年缺陷数" }))
      .toThrow(`QUERY_LIMIT_EXCEEDED:${frame.limit - 1}`);

    const deniedRegistry = {
      ...registry,
      getPolicy(id: string) {
        if (id === "analytics.read_only") return { allowedOperations: [] };
        return registry.getPolicy(id);
      },
    };
    expect(() => createQueryPlanner({ registry: deniedRegistry }).createPlan({ frame, actor, query: "2026 年缺陷数" }))
      .toThrow("PLAN_OPERATION_DENIED:semantic_metric_query");
  });

  it("requires every approved metric's declared filters", () => {
    const unscopedActor = { actorId: "unscoped", scopeHash: "scope-empty", scopes: {} };
    const frame = resolver.resolve({
      query: "团队发现量",
      actor: unscopedActor,
      candidate: { intent: "aggregate", entityIds: ["quality.defect"], metricIds: ["team.defect_discovery_count"], dimensionIds: [] },
    });

    expect(() => planner.createPlan({ frame, actor: unscopedActor, query: "团队发现量" }))
      .toThrow("SEMANTIC_METRIC_REQUIRED_FILTER_MISSING:team.defect_discovery_count:org.problem_finder_team");
  });
});
