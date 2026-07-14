import { describe, expect, it, vi } from "vitest";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";
import { createToolRegistry } from "../../../../server/agentRuntime/toolRegistry.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"] } };
const baseContext = {
  runId: "run-1",
  threadId: "thread-1",
  actor,
  leaseEpoch: 1,
  signal: new AbortController().signal,
  isCancellationRequested: async () => false,
  refreshActor: async () => actor,
  assertCurrentLease: async () => undefined,
};

const makeRegistry = (overrides = {}) => createToolRegistry({
  policy: createRuntimePolicy({ maxExternalSteps: 6, maxCallsPerStep: 3 }),
  executeLegacyTool: vi.fn().mockResolvedValue({
    toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_dashboard_summary", content: "{\"overview\":{\"ticket_count\":12}}" },
    contextText: "Result: 12 defects",
  }),
  analyticsFetch: vi.fn(),
  analyticsApiBase: "http://127.0.0.1:3003",
  runDuplicateBridge: vi.fn(),
  ensureDuplicateWarmup: vi.fn(),
  ...overrides,
});

describe("typed main Agent tools", () => {
  it("publishes only the five read-only graph tools", () => {
    expect(makeRegistry().listForPlanner({ request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph" }).map((tool) => tool.name)).toEqual([
      "query_dashboard_summary",
      "query_testing_coverage_project_status",
      "query_defect_high_frequency_analysis",
      "query_full_picture_module",
      "search_duplicates",
    ]);
  });

  it("rejects unknown arguments before the existing executor sees them", async () => {
    const executeLegacyTool = vi.fn();
    const registry = makeRegistry({ executeLegacyTool });
    await expect(registry.execute({ call: { toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: JSON.stringify({ filters: {}, extra: true }) }, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1, context: baseContext })).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    expect(executeLegacyTool).not.toHaveBeenCalled();
  });

  it("passes the Duplicate bridge exactly its approved payload", async () => {
    const runDuplicateBridge = vi.fn().mockResolvedValue({ success: true, result: { candidates: [] } });
    const registry = createToolRegistry({ policy: createRuntimePolicy(), runDuplicateBridge, ensureDuplicateWarmup: vi.fn(), analyticsFetch: vi.fn(), analyticsApiBase: "http://127.0.0.1:3003" });
    await registry.execute({ call: { toolCallId: "call-1", name: "search_duplicates", argumentsText: JSON.stringify({ query: "camera black screen", top_k: 3 }) }, request: { useAnalyticsContext: false, useDefectContext: true }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1, context: baseContext });
    expect(runDuplicateBridge).toHaveBeenCalledWith({ action: "search", query: "camera black screen", top_k: 3 });
  });

  it("cancels before execution and asserts lease after late results", async () => {
    const controller = new AbortController();
    controller.abort();
    const executeLegacyTool = vi.fn();
    const registry = makeRegistry({ executeLegacyTool });
    await expect(registry.execute({ call: { toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: JSON.stringify({ filters: {} }) }, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1, context: { ...baseContext, signal: controller.signal } })).rejects.toMatchObject({ code: "TOOL_CANCELLED" });
    expect(executeLegacyTool).not.toHaveBeenCalled();

    const assertCurrentLease = vi.fn().mockRejectedValue(Object.assign(new Error("STALE"), { code: "STALE_RUN_LEASE" }));
    const lateRegistry = makeRegistry();
    await expect(lateRegistry.execute({ call: { toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: JSON.stringify({ filters: {} }) }, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1, context: { ...baseContext, assertCurrentLease } })).rejects.toMatchObject({ code: "STALE_RUN_LEASE" });
  });
});