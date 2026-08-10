import { describe, expect, it } from "vitest";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"] } };
const request = { useAnalyticsContext: false, useDefectContext: false };

describe("LegacyPlanValidator policy", () => {
  const policy = createRuntimePolicy({ maxExternalSteps: 6, maxCallsPerStep: 3 });

  it.each([
    [request, "langgraph", "query_dashboard_summary", "ANALYTICS_CONTEXT_DISABLED"],
    [{ useAnalyticsContext: true, useDefectContext: false }, "langgraph", "search_duplicates", "DEFECT_CONTEXT_DISABLED"],
    [{ useAnalyticsContext: false, useDefectContext: true }, "langgraph", "query_testing_coverage_project_status", "ANALYTICS_CONTEXT_DISABLED"],
    [{ useAnalyticsContext: true, useDefectContext: true }, "shadow", "search_duplicates", "SHADOW_DUPLICATE_SEARCH_FORBIDDEN"],
  ])("denies flags=%o mode=%s tool=%s", (flags, runtimeMode, toolName, code) => {
    expect(() => policy.authorizeTool({ actor, request: flags, runtimeMode, toolName, externalStepIndex: 0, callsInStep: 1 })).toThrow(code);
  });

  it("allows each tool only when its explicit request flag permits it", () => {
    expect(policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 0, callsInStep: 1 })).toMatchObject({ riskLevel: "R0" });
    expect(policy.authorizeTool({ actor, request: { useAnalyticsContext: false, useDefectContext: true }, runtimeMode: "langgraph", toolName: "search_duplicates", externalStepIndex: 0, callsInStep: 1 })).toMatchObject({ riskLevel: "R0" });
  });

  it("rejects unregistered capabilities and budget overflow", () => {
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "run_sql", externalStepIndex: 0, callsInStep: 1 })).toThrow(/TOOL_NOT_REGISTERED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 6, callsInStep: 1 })).toThrow(/RUN_STEP_BUDGET_EXCEEDED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 0, callsInStep: 4 })).toThrow(/RUN_TOOL_CALL_BUDGET_EXCEEDED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: Number.NaN, callsInStep: 1 })).toThrow(/RUN_STEP_BUDGET_EXCEEDED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 0, callsInStep: 0 })).toThrow(/RUN_TOOL_CALL_BUDGET_EXCEEDED/);
  });
});