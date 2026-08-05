// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createGovernedAnalysisPlanner } from "../../../../server/ontology/analysisPlanner.mjs";
import { createQueryPlanId, createQueryPlanner, fingerprintQueryPlanSteps } from "../../../../server/ontology/queryPlanner.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

const anchorAt = "2026-07-15T04:00:00.000Z";
const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => anchorAt });
const queryPlanner = createQueryPlanner({ registry });
const analysisPlanner = createGovernedAnalysisPlanner();

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

describe("Governed analysis planner", () => {
  it("creates a bounded line plan for a governed trend query", () => {
    const frame = resolver.resolve({ query: "OS9 最近三个月新增缺陷趋势", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "OS9 最近三个月新增缺陷趋势" });
    const analysisPlan = analysisPlanner.createPlan({ frame, queryPlan });

    expect(analysisPlan).toMatchObject({
      status: "ready",
      sourcePlanId: queryPlan.planId,
      operation: "time_series",
      visualization: "line",
    });
    expect(analysisPlan.maxRows).toBeLessThanOrEqual(50);
    expect(analysisPlan.guardrails).toEqual(expect.arrayContaining([
      "READ_ONLY_SOURCE_PLAN",
      "NO_ARBITRARY_CODE",
      "NO_ARBITRARY_SQL",
    ]));
    expect(analysisPlan.ruleEffects).toContainEqual({
      ruleId: "business.defect_created_count.creation_time",
      kind: "require",
      code: "BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time",
    });
  });

  it("blocks analysis until an ambiguous metric is clarified", () => {
    const frame = resolver.resolve({ query: "缺陷密度", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "缺陷密度" });

    expect(analysisPlanner.createPlan({ frame, queryPlan })).toMatchObject({
      status: "needs_clarification",
      operation: "none",
      visualization: "none",
      maxRows: 0,
    });
  });

  it("projects a denied business rule plan into a denied analysis plan", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const queryPlan = createQueryPlanner({ registry: registryWithDenyRule() })
      .createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(analysisPlanner.createPlan({ frame, queryPlan })).toMatchObject({
      status: "denied",
      operation: "none",
      visualization: "none",
      ruleCodes: ["BUSINESS_RULE_DENY:business.test.no_created_count"],
    });
  });

  it("blocks analysis when a required business event-time semantic is unmet", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const wrongTimeFrame = {
      ...frame,
      timeScopes: frame.timeScopes.map((scope) => ({ ...scope, fieldId: "time.defect_last_modified" })),
    };
    const queryPlan = queryPlanner.createPlan({ frame: wrongTimeFrame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(analysisPlanner.createPlan({ frame: wrongTimeFrame, queryPlan })).toMatchObject({
      status: "needs_clarification",
      operation: "none",
      visualization: "none",
      ruleCodes: ["BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time"],
    });
  });

  it("accepts the canonical query derived from an approved business rule", () => {
    const derivedRegistry = registryWithDerivedProjectRule();
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const queryPlan = createQueryPlanner({ registry: derivedRegistry })
      .createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });
    const derivedAnalysisPlanner = createGovernedAnalysisPlanner({ registry: derivedRegistry });

    expect(derivedAnalysisPlanner.createPlan({ frame, queryPlan })).toMatchObject({
      status: "ready",
      operation: "ranked_comparison",
      visualization: "bar",
    });
  });

  it("marks similarity review as non-population analysis", () => {
    const frame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "蓝牙断连缺陷查重" });
    const analysisPlan = analysisPlanner.createPlan({ frame, queryPlan });

    expect(analysisPlan).toMatchObject({
      status: "ready",
      operation: "similarity_review",
      visualization: "table",
    });
    expect(analysisPlan.guardrails).toContain("SIMILARITY_NOT_POPULATION_STATISTIC");
  });

  it("uses a bounded grouped bar plan for governed period comparison", () => {
    const frame = resolver.resolve({ query: "本周比上周新增缺陷增加多少", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "本周比上周新增缺陷增加多少" });
    const analysisPlan = analysisPlanner.createPlan({ frame, queryPlan });

    expect(analysisPlan).toMatchObject({
      status: "ready",
      operation: "period_comparison",
      visualization: "grouped_bar",
    });
    expect(analysisPlan.maxRows).toBeLessThanOrEqual(50);
  });

  it("accepts the snapshot-bound records continuation shape", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷明细", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷明细" });
    const analysisPlan = analysisPlanner.createPlan({ frame, queryPlan });

    expect(queryPlan.steps[0].canonicalArgs).toMatchObject({
      ontology_version: frame.ontologyVersion,
      schema_fingerprint: frame.schemaFingerprint,
      analysis_ref: null,
      selections: [],
      page: 1,
    });
    expect(analysisPlan).toMatchObject({
      status: "ready",
      operation: "record_table",
      visualization: "table",
    });
  });

  it("rejects a frame that was not validated by the semantic frame contract", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });
    const malformedFrame = { ...frame, intent: "unrecognized" };

    expect(() => analysisPlanner.createPlan({ frame: malformedFrame, queryPlan }))
      .toThrow("SEMANTIC_FRAME_INVALID");
  });

  it("rejects a source plan whose ID is not bound to the semantic frame", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(() => analysisPlanner.createPlan({
      frame,
      queryPlan: { ...queryPlan, planId: "plan-fabricated" },
    })).toThrow("ANALYSIS_PLAN_SOURCE_BINDING_INVALID");
  });

  it("rejects a source plan that bypasses a frame clarification requirement", () => {
    const frame = resolver.resolve({ query: "缺陷密度", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "缺陷密度" });

    expect(() => analysisPlanner.createPlan({
      frame,
      queryPlan: { ...queryPlan, status: "valid" },
    })).toThrow("ANALYSIS_PLAN_SOURCE_STATUS_INVALID");
  });

  it("rejects a ready source plan with missing execution steps", () => {
    const frame = resolver.resolve({ query: "最近一周 DTSV 新增缺陷按 ECU Top 5", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "最近一周 DTSV 新增缺陷按 ECU Top 5" });

    expect(() => analysisPlanner.createPlan({
      frame,
      queryPlan: { ...queryPlan, steps: [] },
    })).toThrow("ANALYSIS_PLAN_SOURCE_STEPS_INVALID");
  });

  it("rejects a similarity plan whose search payload no longer matches its fingerprint", () => {
    const frame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "蓝牙断连缺陷查重" });
    const [step] = queryPlan.steps;

    expect(() => analysisPlanner.createPlan({
      frame,
      queryPlan: {
        ...queryPlan,
        steps: [{ ...step, canonicalArgs: { ...step.canonicalArgs, query: "unrelated payload" } }],
      },
    })).toThrow("ANALYSIS_PLAN_SOURCE_QUERY_INVALID");
  });

  it("rejects extra executable fields in a similarity step", () => {
    const frame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "蓝牙断连缺陷查重" });
    const [step] = queryPlan.steps;

    expect(() => analysisPlanner.createPlan({
      frame,
      queryPlan: {
        ...queryPlan,
        steps: [{ ...step, canonicalArgs: { ...step.canonicalArgs, python: "not executed" } }],
      },
    })).toThrow("ANALYSIS_PLAN_SOURCE_STEPS_INVALID");
  });

  it("rejects a self-consistent similarity plan with a query different from the resolver-bound source", () => {
    const frame = resolver.resolve({ query: "蓝牙断连缺陷查重", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "蓝牙断连缺陷查重" });
    const [step] = queryPlan.steps;
    const steps = [{ ...step, canonicalArgs: { ...step.canonicalArgs, query: "unrelated payload" } }];
    const executionFingerprint = fingerprintQueryPlanSteps(steps);
    const tamperedPlan = {
      ...queryPlan,
      steps,
      executionFingerprint,
      planId: createQueryPlanId({
        frame,
        actorScopeHash: queryPlan.actorScopeHash,
        sourceQueryFingerprint: queryPlan.sourceQueryFingerprint,
        executionFingerprint,
      }),
    };

    expect(() => analysisPlanner.createPlan({ frame, queryPlan: tamperedPlan }))
      .toThrow("ANALYSIS_PLAN_SOURCE_QUERY_INVALID");
  });

  it("rejects a digest-equivalent but noncanonical similarity payload", () => {
    const frame = resolver.resolve({ query: "A duplicate", actor });
    const queryPlan = queryPlanner.createPlan({ frame, actor, query: "A duplicate" });
    const [step] = queryPlan.steps;
    const steps = [{ ...step, canonicalArgs: { ...step.canonicalArgs, query: "\uFF21   duplicate" } }];
    const executionFingerprint = fingerprintQueryPlanSteps(steps);
    const tamperedPlan = {
      ...queryPlan,
      steps,
      executionFingerprint,
      planId: createQueryPlanId({
        frame,
        actorScopeHash: queryPlan.actorScopeHash,
        sourceQueryFingerprint: queryPlan.sourceQueryFingerprint,
        executionFingerprint,
      }),
    };

    expect(() => analysisPlanner.createPlan({ frame, queryPlan: tamperedPlan }))
      .toThrow("ANALYSIS_PLAN_SOURCE_QUERY_INVALID");
  });
});