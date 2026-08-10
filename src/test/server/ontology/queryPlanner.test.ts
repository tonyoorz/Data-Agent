// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";
import { createQueryPlanner } from "../../../../server/ontology/queryPlanner.mjs";
import { composeSourceQuery, fingerprintSourceQuery } from "../../../../server/ontology/fingerprint.mjs";

const anchorAt = "2026-07-15T04:00:00.000Z";
const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => anchorAt });
const planner = createQueryPlanner({ registry });

function registryWithDenyRule() {
  const denyRule = {
    id: "business.test.no_created_count",
    version: "1.0.0",
    kind: "deny",
    appliesTo: { metricIds: ["defect.created_count"], intents: ["rank"] },
    effect: {
      denialCode: "BUSINESS_RULE_DENY:business.test.no_created_count",
      message: "Created defect ranking is blocked for this policy test.",
    },
    governance: { status: "approved", owner: "Agent Security" },
  };
  return {
    ...registry,
    listBusinessRules({ status, kind } = {}) {
      const rules = [...registry.listBusinessRules({ status }), denyRule];
      return kind ? rules.filter((rule) => rule.kind === kind) : rules;
    },
  };
}

function registryWithDerivedProjectRule() {
  const deriveRule = {
    id: "business.test.project_scope",
    version: "1.0.0",
    kind: "derive",
    appliesTo: { metricIds: ["defect.created_count"], intents: ["rank"] },
    effect: {
      derivedFilter: { dimensionId: "product.project", operator: "in", values: ["SP25"] },
      message: "This policy test is scoped to SP25.",
    },
    governance: { status: "approved", owner: "Quality Analytics" },
  };
  return {
    ...registry,
    listBusinessRules({ status, kind } = {}) {
      const rules = [...registry.listBusinessRules({ status }), deriveRule];
      return kind ? rules.filter((rule) => rule.kind === kind) : rules;
    },
  };
}

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
    expect(first.warnings).not.toContain("BUSINESS_RULE:business.defect_created_count.creation_time");
    expect(first.warnings).toContain("CONSTRAINT:planner.forbid_arbitrary_sql");
    expect(first.ruleEffects).toContainEqual({
      ruleId: "business.defect_created_count.creation_time",
      kind: "require",
      code: "BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time",
    });
  });

  it("denies matching approved business rules before creating semantic tool steps", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const deniedPlan = createQueryPlanner({ registry: registryWithDenyRule() })
      .createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(deniedPlan).toMatchObject({
      status: "denied",
      steps: [],
      violations: ["BUSINESS_RULE_DENY:business.test.no_created_count"],
    });
  });

  it("requires created-defect queries to keep their creation-time semantics", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const wrongTimeFrame = {
      ...frame,
      timeScopes: frame.timeScopes.map((scope) => ({ ...scope, fieldId: "time.defect_last_modified" })),
    };
    const plan = planner.createPlan({ frame: wrongTimeFrame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(plan).toMatchObject({
      status: "needs_clarification",
      steps: [],
      violations: ["BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time"],
    });
  });

  it("derives approved policy filters into the canonical semantic query", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const plan = createQueryPlanner({ registry: registryWithDerivedProjectRule() })
      .createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(plan.warnings).toContain("BUSINESS_RULE_DERIVE:business.test.project_scope");
    expect(plan.steps[0].canonicalArgs.query.filters).toContainEqual({
      dimensionId: "product.project",
      operator: "in",
      values: ["SP25"],
      source: "policy",
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
    const tracePlan = planner.createPlan({ frame: traceFrame, actor, query: "追溯 Requirement 到 Defect" });
    expect(tracePlan.steps[0].toolName).toBe("query_traceability");
    expect(tracePlan.warnings).toContain("RELATIONSHIP_PATH:testing.test_case.validates.aida_node>testing.test_run.executes.test_case>quality.defect.detected_in.test_run");
    const similarityPlan = planner.createPlan({ frame: similarityFrame, actor, query: "蓝牙断连缺陷查重" });
    expect(similarityPlan.steps[0].toolName).toBe("search_duplicates");
    expect(similarityPlan.warnings).toContain("CONSTRAINT:similarity.not_population_statistic");
  });

  it("rejects a trace plan when an approved relationship segment is unavailable", () => {
    const frame = resolver.resolve({ query: "追溯 Requirement 到 Defect", actor });
    const registryWithoutRunLink = {
      ...registry,
      getRelationship(relationshipId: string) {
        if (relationshipId === "testing.test_run.executes.test_case") throw new Error("relationship unavailable");
        return registry.getRelationship(relationshipId);
      },
    };

    expect(() => createQueryPlanner({ registry: registryWithoutRunLink })
      .createPlan({ frame, actor, query: "追溯 Requirement 到 Defect" }))
      .toThrow("SEMANTIC_UNSUPPORTED_JOIN:testing.test_case:testing.test_run");
  });

  it("rejects a trace plan with an unbounded many-to-many relationship", () => {
    const frame = resolver.resolve({ query: "追溯 Requirement 到 Defect", actor });
    const registryWithUnboundedPath = {
      ...registry,
      getRelationship(relationshipId: string) {
        const relationship = registry.getRelationship(relationshipId);
        return relationship.id === "testing.test_case.validates.aida_node"
          ? { ...relationship, explosionPolicy: undefined }
          : relationship;
      },
    };

    expect(() => createQueryPlanner({ registry: registryWithUnboundedPath })
      .createPlan({ frame, actor, query: "追溯 Requirement 到 Defect" }))
      .toThrow("SEMANTIC_UNBOUNDED_CARDINALITY:testing.test_case.validates.aida_node");
  });

  it("binds a similarity plan to the resolver-originated search payload", () => {
    const frame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    const expected = planner.createPlan({ frame, actor, query: "蓝牙断连缺陷查重" });

    expect(expected.steps[0].canonicalArgs).toEqual({ query: "蓝牙断连缺陷查重", top_k: 20 });
    expect(expected.sourceQueryFingerprint).toBe(frame.sourceQueryFingerprint);
    expect(() => planner.createPlan({ frame, actor, query: "unrelated payload" }))
      .toThrow("QUERY_PLAN_SOURCE_QUERY_MISMATCH");
  });

  it("binds clarified similarity semantics to one effective source query", () => {
    const query = "这个";
    const clarification = { selection: "补充其他明确口径", text: "蓝牙断连缺陷查重" };
    const effectiveSourceQuery = composeSourceQuery(query, clarification.text);
    const frame = resolver.resolve({ query, actor, clarification });
    const plan = planner.createPlan({ frame, actor, query: effectiveSourceQuery });

    expect(frame.intent).toBe("similarity");
    expect(frame.sourceQueryFingerprint).toBe(fingerprintSourceQuery(effectiveSourceQuery));
    expect(plan.steps[0].canonicalArgs).toEqual({ query: effectiveSourceQuery, top_k: 20 });
    expect(() => planner.createPlan({ frame, actor, query }))
      .toThrow("QUERY_PLAN_SOURCE_QUERY_MISMATCH");
  });

  it("uses the canonical normalized source as the similarity execution payload", () => {
    const rawQuery = "\uFF21   duplicate";
    const frame = resolver.resolve({ query: rawQuery, actor });
    const plan = planner.createPlan({ frame, actor, query: rawQuery });

    expect(frame.sourceQueryFingerprint).toBe(fingerprintSourceQuery("A duplicate"));
    expect(plan.steps[0].canonicalArgs).toEqual({ query: "A duplicate", top_k: 20 });
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
        fields: ["defect_id", "name", "status", "assigned_ecu", "problem_finder_team", "creation_time", "reporting_class", "problem_severity"],
        page: 1,
        page_size: 20,
      },
    });
  });

  it("plans severe defect ID lists with classification and BI policy filters", () => {
    const query = "最近7天一些严重的defect，带着id展示";
    const frame = resolver.resolve({ query, actor });
    const plan = planner.createPlan({ frame, actor, query });

    expect(plan.steps[0]).toMatchObject({
      operation: "semantic_record_query",
      toolName: "query_semantic_records",
      metricIds: ["defect.severe_count"],
      canonicalArgs: {
        fields: ["defect_id", "name", "status", "assigned_ecu", "problem_finder_team", "creation_time", "reporting_class", "problem_severity"],
      },
    });
    expect(plan.steps[0].canonicalArgs.query.filters).toEqual(expect.arrayContaining([
      {
        dimensionId: "quality.reporting_class",
        operator: "in",
        values: ["Showstopper_Candidate", "Showstopper_Confirmed"],
        source: "policy",
      },
      {
        dimensionId: "quality.business_impact",
        operator: "in",
        values: ["04-deficient", "05-unsatisfactory", "06-customer irritated"],
        source: "policy",
      },
    ]));
    expect(plan.ruleEffects).toEqual(expect.arrayContaining([
      {
        ruleId: "business.severe_defect.classification",
        kind: "derive",
        code: "BUSINESS_RULE_DERIVE:business.severe_defect.classification",
      },
      {
        ruleId: "business.severe_defect.business_impact",
        kind: "derive",
        code: "BUSINESS_RULE_DERIVE:business.severe_defect.business_impact",
      },
    ]));
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
