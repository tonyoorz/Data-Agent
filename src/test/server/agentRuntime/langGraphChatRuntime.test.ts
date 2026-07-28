import { describe, expect, it, vi } from "vitest";

import {
  createLangGraphChatRuntime,
  resolveAgentRuntimeMode,
} from "../../../../server/agentRuntime/langGraphChatRuntime.mjs";

describe("LangGraph chat runtime", () => {
  it("uses LangGraph as the default runtime mode", () => {
    expect(resolveAgentRuntimeMode({})).toBe("langgraph");
    expect(resolveAgentRuntimeMode({ VIZION_AGENT_RUNTIME: "" })).toBe("langgraph");
    expect(resolveAgentRuntimeMode({ VIZION_AGENT_RUNTIME: "langgraph" })).toBe("langgraph");
    expect(resolveAgentRuntimeMode({ VIZION_AGENT_RUNTIME: "legacy" })).toBe("langgraph");
    expect(resolveAgentRuntimeMode({ VIZION_AGENT_RUNTIME: "pi" })).toBe("langgraph");
  });

  it("resolves analytics context and existing tool loop through a graph run", async () => {
    const resolveAnalyticsContext = vi.fn().mockResolvedValue({
      contextText: "# Analytics context",
      skipDefectContext: false,
    });
    const resolveDefectContext = vi.fn();
    const toolCalls = [{ id: "call-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } }];
    const shouldPlanTools = vi.fn().mockReturnValue(true);
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls, answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "No more tools.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Tool context",
      toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_semantic_metrics", content: "{}" },
    });
    const events: object[] = [];
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext,
      resolveDefectContext,
      shouldPlanTools,
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-07-23T08:00:00.000Z"),
    });

    const result = await runtime.invoke(
      {
        body: {
          threadId: "thread-123",
          model: "deepseek-v4-flash",
          useAnalyticsContext: true,
          useDefectContext: false,
          context: "# User supplied context",
          messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
        },
        toolDependencies: { runDuplicateBridge: "bridge" },
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(result.runtime).toBe("langgraph");
    expect(result.threadId).toBe("thread-123");
    expect(result.context).toContain("# User supplied context");
    expect(result.context).toContain("# Analytics context");
    expect(result.context).toContain("# Tool context");
    expect(result.finalMessages).toEqual([
      { role: "user", content: "DTSV 6月份提了多少bug？" },
      { role: "assistant", content: "", tool_calls: toolCalls },
      { role: "tool", tool_call_id: "call-1", name: "query_semantic_metrics", content: "{}" },
    ]);
    expect(result.prefaceEvents).toEqual([
      { type: "tool-input-available", toolCallId: "call-1", toolName: "query_semantic_metrics", input: {} },
      { type: "tool-output-available", toolCallId: "call-1", toolName: "query_semantic_metrics", outputSummary: "# Tool context" },
    ]);
    expect(result.events.map((event: { type?: string }) => event.type)).toEqual(expect.arrayContaining([
      "agent.tool.started",
      "agent.tool.completed",
    ]));
    expect(result.metrics.mainAgentToolCallCount).toBe(1);
    expect(resolveAnalyticsContext).toHaveBeenCalledWith({ messages: result.body.messages });
    expect(resolveDefectContext).not.toHaveBeenCalled();
    expect(requestToolCompletion).toHaveBeenCalledTimes(2);
    expect(requestToolCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: result.body.messages,
        model: "deepseek-v4-flash",
        context: expect.stringContaining("# Analytics context"),
        tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "query_semantic_metrics" }) })]),
        toolChoice: "auto",
      }),
    );
    expect(executeToolCall).toHaveBeenCalledWith(toolCalls[0], { runDuplicateBridge: "bridge" });
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({
      shouldUseTools: true,
      intent: "metric_query",
      toolNames: expect.arrayContaining(["query_analytics", "diagnose_analytics_empty"]),
    }));
    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "agent-runtime-started",
      "analytics-context-started",
      "tool-routing-completed",
      "tool-planning-started",
      "agent-runtime-ready",
    ]);
  });

  it("uses one generated thread id for graph config, state, and events", async () => {
    const events: Array<{ threadId?: string }> = [];
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn(),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(false),
      now: () => new Date("2026-07-23T08:00:00.000Z"),
    });

    const result = await runtime.invoke(
      {
        body: {
          messages: [{ role: "user", content: "hello" }],
        },
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(result.threadId).toMatch(/^chat-/);
    expect(events.map((event) => event.threadId).filter(Boolean)).toEqual([
      result.threadId,
      result.threadId,
      result.threadId,
    ]);
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({ shouldUseTools: false }));
  });

  it("persists actor scope, run events, checkpoint, and tool-call audit", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const toolCall = { id: "call-1", type: "function", function: { name: "query_semantic_metrics", arguments: '{"query":{"intent":"rank"}}' } };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [toolCall], answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "Done.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Main agent semantic tool result",
      toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_semantic_metrics", content: "{}" },
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      runtimeStore,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        runId: "run-123",
        threadId: "thread-123",
        useAnalyticsContext: true,
        actor: {
          actorId: "u1",
          scopeHash: "scope-1",
          scopes: { projectIds: ["App"], teamIds: ["DTSV_China"] },
        },
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
      toolDependencies: { analyticsFetch: "fetch" },
    });

    expect(result.runId).toBe("run-123");
    expect(result.actorScope).toEqual({
      actorId: "u1",
      scopeHash: "scope-1",
      scopes: { projectIds: ["App"], teamIds: ["DTSV_China"] },
    });
    expect(executeToolCall).toHaveBeenCalledWith(toolCall, expect.objectContaining({
      analyticsFetch: "fetch",
      actor: result.actorScope,
    }));
    expect(runtimeStore.appendRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-123", threadId: "thread-123", type: "agent-runtime-started" }),
    );
    expect(runtimeStore.writeThreadCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-123",
        threadId: "thread-123",
        actorScope: result.actorScope,
        checkpoint: expect.objectContaining({ metrics: expect.objectContaining({ mainAgentToolCallCount: 1 }) }),
      }),
    );
    expect(runtimeStore.appendToolAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-123",
        threadId: "thread-123",
        actorScope: result.actorScope,
        toolCallId: "call-1",
        toolName: "query_semantic_metrics",
        input: { query: { intent: "rank" } },
        outputSummary: "# Main agent semantic tool result",
      }),
    );
  });
});