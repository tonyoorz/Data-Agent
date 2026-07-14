// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMainAgentGraph, createGraphNodes } from "../../../../server/agentRuntime/graph.mjs";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"] } };

describe("Phase 1 graph", () => {
  it("executes the analytics happy path with provisional events and no early answer deltas", async () => {
    const eventInputs = [];
    const toolRegistry = {
      execute: vi.fn().mockResolvedValue({
        status: "succeeded",
        toolName: "query_dashboard_summary",
        toolVersion: "legacy-tool-v1",
        canonicalArgs: { filters: { years: 2026 } },
        rawResult: { toolMessage: { content: "{\"overview\":{\"ticket_count\":12}}" }, contextText: "Result: 12 defects" },
      }),
    };
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
    expect(state.semanticFrame.mode).toBe("legacy_provisional");
    expect(state.evidence[0].quality.groundingStatus).toBe("legacy_equivalence");
    expect(state.answer.groundingStatus).toBe("legacy_equivalence");
    expect(state.answer.text).toContain("12");
    expect(eventInputs.find((event) => event.type === "ontology.resolved").payload.mode).toBe("legacy_provisional");
    expect(eventInputs.find((event) => event.type === "evidence.added").payload.groundingStatus).toBe("legacy_equivalence");
    const answerIndex = eventInputs.findIndex((event) => event.type === "answer.delta");
    const claimsIndex = eventInputs.findIndex((event) => event.type === "claims.validated");
    expect(answerIndex).not.toBe(-1);
    expect(claimsIndex).not.toBe(-1);
    expect(answerIndex).toBeGreaterThan(claimsIndex);
  });

  it("passes real step indices and cancellation context into tool execution", async () => {
    const controller = new AbortController();
    const indices = [];
    const toolRegistry = { execute: vi.fn(async ({ externalStepIndex }) => { indices.push(externalStepIndex); return { status: "succeeded", toolName: "query_dashboard_summary", toolVersion: "legacy-tool-v1", canonicalArgs: {}, rawResult: { toolMessage: { content: "{\"overview\":{\"ticket_count\":12}}" }, contextText: "Result: 12 defects" } }; }) };
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z", executionContext: { signal: controller.signal, isCancellationRequested: async () => false } });

    await graph.invoke({ runId: "run-1", threadId: "thread-1", actor, request: { messageId: "msg-1", text: "2026 年有多少缺陷？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: true, useDefectContext: false } });

    expect(indices).toEqual([0]);
    expect(toolRegistry.execute.mock.calls[0][0].context.signal).toBe(controller.signal);
  });

  it("does not call disabled tool categories", async () => {
    const toolRegistry = { execute: vi.fn() };
    const graph = createMainAgentGraph({ policy: createRuntimePolicy(), toolRegistry, emitEvent: vi.fn(), now: () => "2026-07-14T00:00:00.000Z" });

    const state = await graph.invoke({ runId: "run-1", threadId: "thread-1", actor, request: { messageId: "msg-1", text: "camera black screen 是否重复？", selectedModel: "deepseek-v4-flash", useAnalyticsContext: false, useDefectContext: false } });

    expect(toolRegistry.execute).not.toHaveBeenCalled();
    expect(state.answer.groundingStatus).toBe("insufficient_evidence");
  });

  it("exposes named graph nodes for tests and future LangGraph wiring", () => {
    expect(Object.keys(createGraphNodes({}))).toEqual(expect.arrayContaining(["receiveRequest", "resolveSemantics", "createPlan", "executeTool", "validateClaims", "publishAnswer"]));
  });
});