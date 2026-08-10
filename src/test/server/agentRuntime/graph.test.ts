// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMainAgentGraph, createGraphNodes } from "../../../../server/agentRuntime/graph.mjs";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"] } };

function semanticToolResult({ call, metricValue = 12 }) {
  const args = JSON.parse(call.argumentsText);
  const query = args.query;
  const metricValues = Object.fromEntries(query.metricIds.map((metricId) => [metricId, metricValue]));
  const groupedRow = Object.fromEntries(query.dimensionIds.map((dimensionId) => [
    dimensionId,
    dimensionId.startsWith("time.") ? query.timeScopes?.[0]?.start || "2026-07-14" : `fixture-${dimensionId}`,
  ]));
  const payload = {
    schemaVersion: "1.0",
    queryId: call.toolCallId,
    ontologyVersion: query.ontologyVersion,
    schemaFingerprint: query.schemaFingerprint,
    sourceRevision: { sourceId: "analytics.fixture", revisionId: "snapshot-1", status: "pinned", asOf: "2026-07-14T00:00:00.000Z", ingestionWatermark: "snapshot-1" },
    scope: { actorScopeHash: actor.scopeHash, filters: query.filters, timeScopes: query.timeScopes, grain: ["one defect"] },
    data: query.dimensionIds.length ? [{ ...groupedRow, ...metricValues }] : [],
    summary: { metrics: metricValues, rowCount: metricValue },
    quality: { completeness: "complete", missingness: metricValue === 0 ? "zero" : "not_applicable", truncated: false, warnings: [] },
  };
  return {
    status: "succeeded",
    toolName: call.name,
    toolVersion: "ontology-semantic-v1",
    canonicalArgs: args,
    rawResult: { toolMessage: { content: JSON.stringify({ ok: true, tool: call.name, result: payload }) }, contextText: `defect.count: ${metricValue}` },
  };
}

describe("Ontology-native graph", () => {
  it("executes the semantic analytics happy path with grounded evidence and no early answer deltas", async () => {
    const eventInputs = [];
    const toolRegistry = { execute: vi.fn(async (input) => semanticToolResult(input)) };
    const graph = createMainAgentGraph({
      policy: createRuntimePolicy(),
      toolRegistry,
      emitEvent: (event) => eventInputs.push(event),
      now: () => "2026-07-14T00:00:00.000Z",
    });

    const state = await graph.invoke({
      runId: "run-1",
      threadId: "thread-1",
      actor,
      request: { messageId: "msg-1", text: "2026 年有多少缺陷？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false },
    });

    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
    expect(state.semanticFrame.ontologyVersion).toBe("v1");
    expect(state.evidence[0].quality.groundingStatus).toBe("grounded");
    expect(state.answer.groundingStatus).toBe("grounded");
    expect(state.answer.text).toContain("12");
    expect(eventInputs.find((event) => event.type === "ontology.resolved").payload.mode).toBe("ontology_verified");
    expect(eventInputs.find((event) => event.type === "evidence.added").payload.groundingStatus).toBe("grounded");
    const startedPayload = eventInputs.find((event) => event.type === "tool.started").payload;
    expect(startedPayload.redactedCanonicalArgs.query).toMatchObject({ metricIds: ["defect.count"], filters: expect.arrayContaining([expect.objectContaining({ valueCount: 1 })]) });
    expect(JSON.stringify(startedPayload)).not.toContain("SP25");
    expect(JSON.stringify(startedPayload)).not.toContain("DTSV_China");
    const answerIndex = eventInputs.findIndex((event) => event.type === "answer.delta");
    const claimsIndex = eventInputs.findIndex((event) => event.type === "claims.validated");
    expect(answerIndex).toBe(-1);
    expect(claimsIndex).not.toBe(-1);
  });

  it("invokes the selected certified planner and lets Ontology validate its candidate", async () => {
    const emitEvent = vi.fn();
    const modelAdapter = { invoke: vi.fn().mockResolvedValue({
      text: JSON.stringify({ intent: "aggregate", metricIds: ["testing.testcase_count"], dimensionIds: ["product.project"], entityIds: ["testing.test_case"] }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    }) };
    const toolRegistry = { execute: vi.fn(async (input) => semanticToolResult(input)) };
    const graph = createMainAgentGraph({ modelAdapter, policy: createRuntimePolicy(), toolRegistry, emitEvent, now: () => "2026-07-14T00:00:00.000Z" });

    const state = await graph.invoke({ runId: "run-model", threadId: "thread-model", actor, request: { messageId: "msg-model", text: "给我按项目看的用例规模", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    expect(modelAdapter.invoke).toHaveBeenCalledWith(expect.objectContaining({ modelId: "deepseek-v4-flash", purpose: "planning", outputSchema: expect.any(Object) }), expect.any(Object));
    expect(state.semanticFrame).toMatchObject({ metricIds: ["testing.testcase_count"], dimensionIds: ["product.project"] });
    expect(state.modelTurns[0]).toMatchObject({ modelId: "deepseek-v4-flash", status: "completed" });
    expect(emitEvent).toHaveBeenCalledWith({
      type: "model.completed",
      payload: { modelId: "deepseek-v4-flash", purpose: "planning", finishReason: "stop", inputTokens: 10, outputTokens: 5 },
    });
    const completedEvent = emitEvent.mock.calls.map(([event]) => event).find((event) => event.type === "model.completed");
    expect(Object.keys(completedEvent.payload).sort()).toEqual(["finishReason", "inputTokens", "modelId", "outputTokens", "purpose"]);
    expect(JSON.stringify(completedEvent.payload)).not.toContain("testing.testcase_count");
  });

  it("uses deterministic Ontology fallback without exposing model output", async () => {
    const emitEvent = vi.fn();
    const graph = createMainAgentGraph({
      modelAdapter: { invoke: vi.fn().mockRejectedValue(Object.assign(new Error("provider unavailable"), { code: "MODEL_HTTP_503", retryable: true })) },
      policy: createRuntimePolicy(),
      toolRegistry: { execute: vi.fn(async (input) => semanticToolResult(input)) },
      emitEvent,
      now: () => "2026-07-14T00:00:00.000Z",
    });

    const state = await graph.invoke({ runId: "run-fallback", threadId: "thread-fallback", actor, request: { messageId: "msg-fallback", text: "2026 年有多少缺陷？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    expect(state.answer.groundingStatus).toBe("grounded");
    expect(state.warnings).toContain("MODEL_SEMANTIC_FALLBACK");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "model.fallback" }));
    expect(JSON.stringify(state.modelTurns)).not.toContain("provider unavailable");
    expect(JSON.stringify(emitEvent.mock.calls)).not.toContain("provider unavailable");
  });

  it("propagates shadow mode so duplicate search is never executed twice", async () => {
    const toolRegistry = { execute: vi.fn() };
    const graph = createMainAgentGraph({ runtimeMode: "shadow", policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z" });

    await expect(graph.invoke({ runId: "run-shadow", threadId: "thread-shadow", actor, request: { messageId: "msg-shadow", text: "给 camera black screen 缺陷做查重", selectedModel: "deepseek-v4-flash", useAnalyticsContext: false, useDefectContext: true } })).rejects.toThrow("SHADOW_DUPLICATE_SEARCH_FORBIDDEN");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it("passes real step indices and cancellation context into tool execution", async () => {
    const controller = new AbortController();
    const indices = [];
    const toolRegistry = { execute: vi.fn(async (input) => { indices.push(input.externalStepIndex); return semanticToolResult(input); }) };
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z", executionContext: { signal: controller.signal, isCancellationRequested: async () => false } });

    await graph.invoke({ runId: "run-1", threadId: "thread-1", actor, request: { messageId: "msg-1", text: "2026 年有多少缺陷？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    expect(indices).toEqual([0]);
    expect(toolRegistry.execute.mock.calls[0][0].context.signal).toBe(controller.signal);
  });

  it("executes multiple metric steps in dependency order and cites every accepted claim", async () => {
    const modelAdapter = { invoke: vi.fn().mockResolvedValue({
      text: JSON.stringify({ intent: "aggregate", metricIds: ["defect.count", "defect.created_count"], dimensionIds: [], entityIds: ["quality.defect"] }),
      finishReason: "stop",
      usage: { inputTokens: 8, outputTokens: 4 },
    }) };
    const indices = [];
    const toolRegistry = { execute: vi.fn(async (input) => {
      indices.push(input.externalStepIndex);
      return semanticToolResult({ ...input, metricValue: input.externalStepIndex + 10 });
    }) };
    const graph = createMainAgentGraph({ modelAdapter, policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z" });

    const state = await graph.invoke({ runId: "run-multi", threadId: "thread-multi", actor, request: { messageId: "msg-multi", text: "今年缺陷总数和新增缺陷数", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    expect(indices).toEqual([0, 1]);
    expect(state.plan.steps).toMatchObject([
      { stepId: "s1", metricIds: ["defect.created_count"], dependsOn: [] },
      { stepId: "s2", metricIds: ["defect.count"], dependsOn: ["s1"] },
    ]);
    expect(state.evidence).toHaveLength(2);
    expect(state.answer.acceptedClaimIds).toHaveLength(2);
    expect(new Set(state.answer.citations.flatMap((citation) => citation.claimIds))).toEqual(new Set(state.answer.acceptedClaimIds));
  });

  it("replans once with a smaller limit after an oversized tool result", async () => {
    const emitted = [];
    const toolRegistry = { execute: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("TOOL_OUTPUT_TOO_LARGE"), { code: "TOOL_OUTPUT_TOO_LARGE", status: "failed", retryable: false }))
      .mockImplementationOnce(async (input) => semanticToolResult(input)) };
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry, emitEvent: (event) => emitted.push(event), now: () => "2026-07-14T00:00:00.000Z" });

    const state = await graph.invoke({ runId: "run-replan", threadId: "thread-replan", actor, request: { messageId: "msg-replan", text: "2026 年缺陷数 Top 8", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    const firstLimit = JSON.parse(toolRegistry.execute.mock.calls[0][0].call.argumentsText).query.limit;
    const secondLimit = JSON.parse(toolRegistry.execute.mock.calls[1][0].call.argumentsText).query.limit;
    expect(toolRegistry.execute).toHaveBeenCalledTimes(2);
    expect(secondLimit).toBe(Math.max(1, Math.floor(firstLimit / 2)));
    expect(state.plan).toMatchObject({ version: 2, warnings: expect.arrayContaining(["REPLANNED_AFTER_TOOL_OUTPUT_TOO_LARGE"]) });
    expect(state.answer.groundingStatus).toBe("grounded");
    expect(emitted.map((event) => event.type)).toEqual(expect.arrayContaining(["tool.failed", "plan.updated", "plan.validated", "tool.completed"]));
  });

  it("does not call disabled tool categories", async () => {
    const toolRegistry = { execute: vi.fn() };
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z" });

    await expect(graph.invoke({ runId: "run-1", threadId: "thread-1", actor, request: { messageId: "msg-1", text: "camera black screen 是否重复？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: false, useDefectContext: false } })).rejects.toThrow("ANALYTICS_CONTEXT_DISABLED");
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it("exposes named graph nodes for tests and future LangGraph wiring", () => {
    expect(Object.keys(createGraphNodes({}))).toEqual(expect.arrayContaining([
      "receiveRequest", "prepareInputs", "loadThreadContext", "resolveSemantics", "validateSemantics",
      "createPlan", "validatePlan", "executeStep", "evaluateStepResult", "replanOrContinue",
      "buildEvidence", "validateClaims", "renderAnswer", "validateAnswer", "repairAnswer",
      "publishAnswer", "compactContext",
    ]));
  });

  it("compiles a real LangGraph graph with invoke and stream entry points", () => {
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry: { execute: vi.fn() }, emitEvent: vi.fn() });

    expect(typeof graph.invoke).toBe("function");
    expect(typeof graph.stream).toBe("function");
  });
});
