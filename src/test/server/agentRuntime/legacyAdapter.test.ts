import { describe, expect, it } from "vitest";
import { createLegacySemanticAdapter, validateLegacyPlan } from "../../../../server/agentRuntime/legacyAdapter.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"] } };

describe("Phase 1 semantic compatibility", () => {
  it("marks all frames provisional and anchors relative dates in Asia/Shanghai", () => {
    const adapter = createLegacySemanticAdapter({ timezone: "Asia/Shanghai", now: () => "2026-07-14T12:00:00+08:00" });
    const frame = adapter.resolve({ query: "最近一周 DTSV 新增缺陷有多少？", actor });
    expect(frame.ref.ontologyVersion).toBe("legacy-provisional");
    expect(frame.mode).toBe("legacy_provisional");
    expect(frame.timeScopes[0]).toMatchObject({ fieldId: "legacy.creation_time", start: "2026-07-08", end: "2026-07-14", timezone: "Asia/Shanghai" });
  });

  it("cannot compile around either request flag", () => {
    const candidate = { steps: [{ stepId: "s1", toolName: "search_duplicates", canonicalArgs: { query: "camera", top_k: 3 }, dependsOn: [] }] };
    expect(validateLegacyPlan({ candidate, actor, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph" })).toMatchObject({ status: "denied", violations: ["DEFECT_CONTEXT_DISABLED"] });
    expect(validateLegacyPlan({ candidate: { steps: [{ stepId: "s2", toolName: "query_dashboard_summary", canonicalArgs: { filters: {} }, dependsOn: [] }] }, actor, request: { useAnalyticsContext: false, useDefectContext: true }, runtimeMode: "langgraph" })).toMatchObject({ status: "denied", violations: ["ANALYTICS_CONTEXT_DISABLED"] });
  });
});