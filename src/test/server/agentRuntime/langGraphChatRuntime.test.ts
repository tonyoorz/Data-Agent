import { describe, expect, it, vi } from "vitest";

import {
  createLangGraphChatRuntime,
  resolveAgentRuntimeMode,
} from "../../../../server/agentRuntime/langGraphChatRuntime.mjs";
import { fingerprintQueryPlanSteps } from "../../../../server/ontology/queryPlanner.mjs";

function analyticsActor(scopeHash: string, actorId = "u1") {
  return {
    actorId,
    scopeHash,
    scopes: {
      workspaceIds: ["DTSV"],
      allowedObjectTypes: ["quality.defect"],
    },
  };
}

function deterministicMetricPlan(actorScopeHash: string) {
  const steps = [{
    stepId: "s1",
    operation: "semantic_metric_query",
    toolName: "query_semantic_metrics",
    metricIds: ["defect.count"],
    dimensionIds: ["product.ecu"],
    canonicalArgs: { query: { intent: "rank", metricIds: ["defect.count"] } },
    dependsOn: [],
    riskLevel: "R0",
  }];
  return {
    schemaVersion: "1.0",
    planId: "plan-direct-1",
    version: 1,
    status: "valid",
    ontologyVersion: "v1",
    schemaFingerprint: "f".repeat(64),
    actorScopeHash,
    sourceQueryFingerprint: "a".repeat(64),
    executionFingerprint: fingerprintQueryPlanSteps(steps),
    steps,
    violations: [],
    warnings: [],
    ruleEffects: [],
  };
}

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
            actor: analyticsActor("scope-1"),
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
    expect(result.finalMessages).toEqual([{ role: "user", content: "DTSV 6月份提了多少bug？" }]);
    expect(result.prefaceEvents).toEqual([
      { type: "tool-input-available", toolCallId: "call-1", toolName: "query_semantic_metrics", input: {} },
      { type: "tool-output-available", toolCallId: "call-1", toolName: "query_semantic_metrics", outputSummary: "# Tool context" },
    ]);
    expect(result.events.map((event: { type?: string }) => event.type)).toEqual(expect.arrayContaining([
      "agent.tool.started",
      "agent.tool.completed",
    ]));
    expect(result.metrics.mainAgentToolCallCount).toBe(1);
    expect(resolveAnalyticsContext).toHaveBeenCalledWith({
      messages: result.body.messages,
      actor: result.actorScope,
      ontologyRegistry: expect.objectContaining({ version: "v1" }),
    });
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
    expect(executeToolCall).toHaveBeenCalledWith(toolCalls[0], {
      runDuplicateBridge: "bridge",
      actor: result.actorScope,
    });
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

  it("resolves a named defect reporter before model-planned aggregation", async () => {
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function.name === "search_analytics_filter_values") {
        return {
          contextText: "# Main agent tool result\nTool: search_analytics_filter_values\nCandidate values: Xumiao: 3",
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "search_analytics_filter_values",
            content: JSON.stringify({
              ok: true,
              tool: "search_analytics_filter_values",
              result: { values: [{ value: "Xumiao", count: 3 }] },
            }),
          },
        };
      }
      return {
        contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: 1",
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "query_analytics",
          content: JSON.stringify({
            ok: true,
            tool: "query_analytics",
            result: { rows: [{ defect_count: 3 }], returned_groups: 1 },
          }),
        },
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-11T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-defect-reporter-lookup",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-reporter-lookup"),
        messages: [{ role: "user", content: "xumiao 提票情况" }],
      },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls[0][0]).toMatchObject({
      id: "defect-reporter-xumiao-filter-values",
      function: { name: "search_analytics_filter_values" },
    });
    expect(JSON.parse(executeToolCall.mock.calls[0][0].function.arguments)).toEqual({
      dataset: "defects",
      field: "detected_by",
      query: "Xumiao",
      limit: 5,
    });
    expect(executeToolCall.mock.calls[1][0]).toMatchObject({
      id: "defect-reporter-xumiao-aggregate",
      function: { name: "query_analytics" },
    });
    expect(JSON.parse(executeToolCall.mock.calls[1][0].function.arguments)).toMatchObject({
      dataset: "defects",
      intent: "aggregate",
      metrics: ["defect_count"],
      dimensions: [],
      filters: { detected_by: ["Xumiao"] },
      time: { field: "creation_time", current: ["2026-01-01", "2026-08-11"], timezone: "Asia/Shanghai" },
    });
    expect(result.mainAgentToolContext.toolCalls.map((toolCall) => toolCall.function.name)).toEqual([
      "search_analytics_filter_values",
      "query_analytics",
    ]);
    expect(requestToolCompletion).not.toHaveBeenCalled();
  });

  it("asks for clarification instead of model-planned fallback when a named reporter has no candidate", async () => {
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function.name === "search_analytics_filter_values") {
        return {
          contextText: "# Main agent tool result\nTool: search_analytics_filter_values\nCandidate values: none",
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "search_analytics_filter_values",
            content: JSON.stringify({
              ok: true,
              tool: "search_analytics_filter_values",
              result: { values: [] },
            }),
          },
        };
      }
      return {
        requiresUserInput: true,
        contextText: "# Main agent tool result\nTool: ask_clarification\nQuestion: provide the Octane name",
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "ask_clarification",
          content: JSON.stringify({ question: "Provide the Octane name" }),
        },
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-11T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-defect-reporter-no-candidate",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-reporter-no-candidate"),
        messages: [{ role: "user", content: "xumiao 提票情况" }],
      },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls[1][0]).toMatchObject({
      id: "defect-reporter-xumiao-clarification",
      function: { name: "ask_clarification" },
    });
    expect(result.mainAgentToolContext.toolCalls.map((toolCall) => toolCall.function.name)).toEqual([
      "search_analytics_filter_values",
      "ask_clarification",
    ]);
    expect(result.mainAgentToolContext.stoppedReason).toBe("clarification_requested");
    expect(requestToolCompletion).not.toHaveBeenCalled();
  });

  it("resolves a name-only clarification reply and continuation command through a reversed defect reporter alias", async () => {
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function.name === "search_analytics_filter_values") {
        const input = JSON.parse(toolCall.function.arguments);
        const values = input.query === "Miao Xu" ? [{ value: "Miao Xu", count: 41 }] : [];
        return {
          contextText: "# Main agent tool result\nTool: search_analytics_filter_values",
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "search_analytics_filter_values",
            content: JSON.stringify({ ok: true, tool: "search_analytics_filter_values", result: { values } }),
          },
        };
      }
      return {
        contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: 1",
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "query_analytics",
          content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [{ defect_count: 41 }], returned_groups: 1 } }),
        },
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-11T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-defect-reporter-name-reply",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-reporter-name-reply"),
        messages: [
          { role: "user", content: "xumiao 提票情况" },
          { role: "assistant", content: "请提供 Octane 中显示的姓名。" },
          { role: "user", content: "xu miao" },
          { role: "assistant", content: "未找到完全匹配的候选。" },
          { role: "user", content: "继续未完成" },
        ],
      },
    });

    expect(executeToolCall.mock.calls.map(([toolCall]) => toolCall.function.name)).toEqual([
      "search_analytics_filter_values",
      "search_analytics_filter_values",
      "query_analytics",
    ]);
    expect(JSON.parse(executeToolCall.mock.calls[0][0].function.arguments)).toMatchObject({ query: "Xu Miao" });
    expect(JSON.parse(executeToolCall.mock.calls[1][0].function.arguments)).toMatchObject({ query: "Miao Xu" });
    expect(JSON.parse(executeToolCall.mock.calls[2][0].function.arguments)).toMatchObject({
      filters: { detected_by: ["Miao Xu"] },
    });
    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(result.mainAgentToolContext.stoppedReason).toBe("deterministic_plan_complete");
  });

  it("stops before executing an identical planned analytics query twice", async () => {
    const firstToolCall = {
      id: "analytics-1",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "rank",
          metrics: ["defect_count"],
          derived_metrics: ["delta", "growth_pct"],
          dimensions: ["assigned_ecu"],
          filters: {},
          time: {
            field: "creation_time",
            current: ["2026-05-06", "2026-08-06"],
            comparison: ["2026-02-06", "2026-05-06"],
            timezone: "Asia/Shanghai",
          },
          order_by: [{ field: "delta", direction: "desc" }],
          limit: 10,
        }),
      },
    };
    const duplicateToolCall = { ...firstToolCall, id: "analytics-2" };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [firstToolCall] })
      .mockResolvedValueOnce({ content: "", toolCalls: [duplicateToolCall] });
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows:\n1. Navigation CN: defect_count 201",
      toolMessage: {
        role: "tool",
        tool_call_id: "analytics-1",
        name: "query_analytics",
        content: JSON.stringify({
          ok: true,
          tool: "query_analytics",
          result: { rows: [{ assigned_ecu: "IDCEVO-25", defect_count: 201 }], returned_groups: 1 },
        }),
      },
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      maxToolSteps: 2,
      now: () => new Date("2026-08-06T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-duplicate-query",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-duplicate-query"),
        messages: [{ role: "user", content: "近三个月缺陷按 ECU 增长排名" }],
      },
    });

    expect(requestToolCompletion).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(result.mainAgentToolContext.toolCalls).toEqual([firstToolCall]);
    expect(result.mainAgentToolContext.stoppedReason).toBe("duplicate_tool_call");
  });

  it("finalizes a completed Top Issue growth rank before optional records drilldown", async () => {
    const catalogToolCall = {
      id: "catalog-1",
      type: "function",
      function: { name: "get_data_catalog", arguments: "{}" },
    };
    const rankToolCall = {
      id: "rank-1",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "rank",
          metrics: ["defect_count"],
          derived_metrics: ["delta", "growth_pct"],
          dimensions: ["business_module"],
          filters: {},
          time: {
            field: "creation_time",
            current: ["2026-05-06", "2026-08-06"],
            comparison: ["2026-02-06", "2026-05-06"],
            timezone: "Asia/Shanghai",
          },
          order_by: [{ field: "delta", direction: "desc" }],
          limit: 10,
        }),
      },
    };
    const recordsToolCall = {
      id: "records-1",
      type: "function",
      function: { name: "query_defect_records", arguments: JSON.stringify({ drilldown_ref: "ref-1", limit: 5 }) },
    };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [catalogToolCall] })
      .mockResolvedValueOnce({ content: "", toolCalls: [rankToolCall] })
      .mockResolvedValueOnce({ content: "", toolCalls: [recordsToolCall] })
      .mockResolvedValueOnce({ content: "", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function.name === "get_data_catalog") {
        return {
          contextText: "# Main agent tool result\nTool: get_data_catalog\nDatasets: defects",
          toolMessage: { role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: JSON.stringify({ ok: true, tool: toolCall.function.name }) },
        };
      }
      return {
        contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows:\n1. Navigation CN: defect_count 201",
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({
            ok: true,
            tool: toolCall.function.name,
            result: { rows: [{ business_module: "Navigation CN", defect_count: 201 }], returned_groups: 1 },
          }),
        },
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-06T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-top-issue-rank",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-top-issue-rank"),
        messages: [{ role: "user", content: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块并给出根因假设。" }],
      },
    });

    expect(requestToolCompletion).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls.map(([toolCall]) => toolCall.function.name)).toEqual([
      "get_data_catalog",
      "query_analytics",
    ]);
    expect(result.mainAgentToolContext.stoppedReason).toBe("top_issue_growth_rank_completed");
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

  it("returns a deterministic direct response for chitchat without tool planning", async () => {
    const requestToolCompletion = vi.fn();
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn(),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      now: () => new Date("2026-07-23T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-chat-1",
        useAnalyticsContext: true,
        messages: [{ role: "user", content: "你好" }],
      },
    });

    expect(result.directResponse).toEqual(expect.objectContaining({ intent: "chitchat" }));
    expect(result.directResponse.content).toContain("测试质量");
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({ shouldUseTools: false, intent: "chitchat" }));
    expect(requestToolCompletion).not.toHaveBeenCalled();
  });

  it("executes a valid canonical QueryPlan without asking the model to plan tools", async () => {
    const actor = {
      actorId: "u1",
      scopeHash: "scope-direct",
      scopes: {
        workspaceIds: ["DTSV"],
        allowedObjectTypes: ["quality.defect"],
      },
    };
    const semanticPlan = deterministicMetricPlan(actor.scopeHash);
    const requestToolCompletion = vi.fn();
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Canonical metric result",
      toolMessage: {
        role: "tool",
        tool_call_id: "plan-direct-1:s1",
        name: "query_semantic_metrics",
        content: "{}",
      },
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        semanticPlan,
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        useAnalyticsContext: true,
        actor,
        messages: [{ role: "user", content: "DTSV 缺陷按 ECU 排名" }],
      },
    });

    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledWith({
      id: "plan-direct-1:s1",
      type: "function",
      function: {
        name: "query_semantic_metrics",
        arguments: JSON.stringify(semanticPlan.steps[0].canonicalArgs),
      },
    }, expect.objectContaining({ actor }));
    expect(result.mainAgentToolContext.stoppedReason).toBe("deterministic_plan_complete");
    expect(result.mainAgentToolContext.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "plan-direct-1:s1" }),
    ]));
  });

  it("falls back to model planning when a canonical QueryPlan scope does not match the actor", async () => {
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        semanticPlan: deterministicMetricPlan("another-scope"),
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    await runtime.invoke({
      body: {
        useAnalyticsContext: true,
        actor: {
          actorId: "u1",
          scopeHash: "scope-fallback",
          scopes: {
            workspaceIds: ["DTSV"],
            allowedObjectTypes: ["quality.defect"],
          },
        },
        messages: [{ role: "user", content: "DTSV 缺陷数按 ECU 排名" }],
      },
    });

    expect(requestToolCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns direct clarification for vague testing status without resolving analytics context", async () => {
    const resolveAnalyticsContext = vi.fn();
    const requestToolCompletion = vi.fn();
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext,
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(false),
      requestToolCompletion,
      now: () => new Date("2026-08-11T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-vague-test-status",
        useAnalyticsContext: true,
        messages: [{ role: "user", content: "测试怎么样" }],
      },
    });

    expect(result.directResponse).toEqual(expect.objectContaining({ intent: "clarification" }));
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({ shouldUseTools: false, intent: "clarification" }));
    expect(resolveAnalyticsContext).not.toHaveBeenCalled();
    expect(requestToolCompletion).not.toHaveBeenCalled();
  });

  it("does not enter tool planning when the governed analysis plan is denied", async () => {
    const requestToolCompletion = vi.fn();
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Governed Ontology interpretation\nPlan status: denied\nPlan violations: BUSINESS_RULE_DENY:business.test.no_created_count\nDo not call tools.",
        skipDefectContext: false,
        analysisPlan: { status: "denied" },
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      now: () => new Date("2026-08-05T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-rule-denied",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-rule-denied"),
        messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }],
      },
    });

    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({ shouldUseTools: false }));
    expect(result.context).toContain("BUSINESS_RULE_DENY:business.test.no_created_count");
  });

  it("executes one ready scope-bound semantic metric plan before model tool planning", async () => {
    const canonicalArgs = {
      query: {
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        intent: "aggregate",
        entityIds: ["quality.defect"],
        metricIds: ["defect.count"],
        dimensionIds: ["quality.defect.status"],
      },
    };
    const analysisPlan = {
      schemaVersion: "1.0",
      analysisPlanId: `analysis-${"c".repeat(16)}`,
      sourcePlanId: `plan-${"d".repeat(16)}`,
      sourcePlanFingerprint: "e".repeat(64),
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      status: "ready",
      operation: "group_comparison",
      visualization: "grouped_bar",
      maxRows: 12,
      guardrails: ["READ_ONLY_SOURCE_PLAN", "NO_ARBITRARY_CODE", "NO_ARBITRARY_SQL", "NO_CAUSAL_CLAIMS"],
      ruleEffects: [],
    };
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Main agent semantic tool result\nTool: query_semantic_metrics\ndefect.count: 12",
      toolMessage: {
        role: "tool",
        tool_call_id: "plan-dddddddddddddddd-s1",
        name: "query_semantic_metrics",
        content: JSON.stringify({ ok: true, tool: "query_semantic_metrics", result: { summary: { metrics: { "defect.count": 12 } } } }),
      },
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        analysisPlan,
        queryPlan: {
          status: "valid",
          actorScopeHash: "scope-a",
          planId: analysisPlan.sourcePlanId,
          steps: [{ stepId: "s1", operation: "semantic_metric_query", toolName: "query_semantic_metrics", canonicalArgs }],
        },
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-06T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-ready-plan",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-a", "alice"),
        messages: [{ role: "user", content: "IDCEVO 当前缺陷数按状态统计" }],
      },
    });

    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      id: "plan-dddddddddddddddd-s1",
      function: { name: "query_semantic_metrics", arguments: JSON.stringify(canonicalArgs) },
    }), expect.objectContaining({ actor: expect.objectContaining({ actorId: "alice", scopeHash: "scope-a" }) }));
    expect(result.mainAgentToolContext.toolCalls).toHaveLength(1);
    expect(result.metrics.mainAgentToolCallCount).toBe(1);
  });

  it("executes one ready scope-bound semantic record plan before model tool planning", async () => {
    const canonicalArgs = {
      ontology_version: "v1",
      schema_fingerprint: "a".repeat(64),
      query: {
        schemaVersion: "1.0",
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        intent: "list",
        entityIds: ["quality.defect"],
        metricIds: ["defect.count"],
        dimensionIds: [],
        filters: [],
        timeScopes: [],
        comparison: null,
        sort: [],
        limit: 20,
      },
      analysis_ref: null,
      selections: [],
      fields: ["defect_id", "name", "reporting_class", "problem_severity"],
      page: 1,
      page_size: 20,
    };
    const analysisPlan = {
      schemaVersion: "1.0",
      analysisPlanId: `analysis-${"c".repeat(16)}`,
      sourcePlanId: `plan-${"d".repeat(16)}`,
      sourcePlanFingerprint: "e".repeat(64),
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      status: "ready",
      operation: "record_table",
      visualization: "table",
      maxRows: 20,
      guardrails: ["READ_ONLY_SOURCE_PLAN", "NO_ARBITRARY_CODE", "NO_ARBITRARY_SQL", "NO_CAUSAL_CLAIMS"],
      ruleEffects: [],
    };
    const requestToolCompletion = vi.fn();
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Main agent semantic tool result\nTool: query_semantic_records\nRows: 1",
      toolMessage: {
        role: "tool",
        tool_call_id: "plan-dddddddddddddddd-s1",
        name: "query_semantic_records",
        content: JSON.stringify({ ok: true, tool: "query_semantic_records", result: { data: [{ defect_id: "D-1" }] } }),
      },
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        analysisPlan,
        queryPlan: {
          status: "valid",
          actorScopeHash: "scope-a",
          planId: analysisPlan.sourcePlanId,
          steps: [{ stepId: "s1", operation: "semantic_record_query", toolName: "query_semantic_records", canonicalArgs }],
        },
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      now: () => new Date("2026-08-06T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-ready-record-plan",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-a", "alice"),
        messages: [{ role: "user", content: "最近7天一些严重的defect，带着id展示" }],
      },
    });

    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: "query_semantic_records", arguments: JSON.stringify(canonicalArgs) },
    }), expect.objectContaining({ actor: expect.objectContaining({ actorId: "alice", scopeHash: "scope-a" }) }));
    expect(result.mainAgentToolContext.toolCalls).toHaveLength(1);
    expect(result.mainAgentToolContext.toolCalls[0].function.name).toBe("query_semantic_records");
  });

  it("does not resolve unscoped duplicate context for an OIDC actor", async () => {
    const resolveDefectContext = vi.fn();
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn(),
      resolveDefectContext,
      shouldPlanTools: vi.fn().mockReturnValue(false),
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    await runtime.invoke({
      body: {
        threadId: "thread-oidc-duplicate",
        useDefectContext: true,
        useAnalyticsContext: false,
        actor: {
          actorId: "alice",
          scopeHash: "oidc-0123456789abcdef",
          scopes: { allowedObjectTypes: ["quality.defect"], teamIds: ["DTSV_China"] },
        },
        messages: [{ role: "user", content: "camera black screen" }],
      },
    });

    expect(resolveDefectContext).not.toHaveBeenCalled();
  });

  it("returns a deterministic direct response for out-of-scope requests", async () => {
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn(),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion: vi.fn(),
      now: () => new Date("2026-07-23T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-oos-1",
        useAnalyticsContext: true,
        messages: [{ role: "user", content: "帮我写一首诗" }],
      },
    });

    expect(result.directResponse).toEqual(expect.objectContaining({ intent: "out_of_scope" }));
    expect(result.directResponse.content).toContain("汽车测试质量");
    expect(result.metrics.toolRouting).toEqual(expect.objectContaining({ shouldUseTools: false, intent: "out_of_scope" }));
  });

  it("persists actor scope, run events, checkpoint, and tool-call audit", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
      appendRunSummary: vi.fn(async () => undefined),
      appendRunSummary: vi.fn(async () => undefined),
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
    const resolveAnalyticsContext = vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext,
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
          scopes: { projectIds: ["App"], teamIds: ["DTSV_China"], allowedObjectTypes: ["quality.defect"] },
        },
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
      toolDependencies: { analyticsFetch: "fetch" },
    });

    expect(result.runId).toBe("run-123");
    expect(result.actorScope).toEqual({
      actorId: "u1",
      scopeHash: "scope-1",
      scopes: { projectIds: ["App"], teamIds: ["DTSV_China"], allowedObjectTypes: ["quality.defect"] },
    });
    expect(executeToolCall).toHaveBeenCalledWith(toolCall, expect.objectContaining({
      analyticsFetch: "fetch",
      actor: result.actorScope,
    }));
    expect(resolveAnalyticsContext).toHaveBeenCalledWith({
      messages: result.body.messages,
      actor: result.actorScope,
      ontologyRegistry: expect.objectContaining({ version: "v1" }),
    });
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
    expect(runtimeStore.appendRunSummary).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-123",
      threadId: "thread-123",
      actorScopeHash: "scope-1",
      intent: "metric_query",
      outcome: "completed",
      toolNames: ["query_semantic_metrics"],
    }));
    expect(JSON.stringify(runtimeStore.appendRunSummary.mock.calls)).not.toContain("DTSV 6月份提了多少bug？");
  });

  it("persists governed analysis plan provenance in runtime audit records", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
      appendRunSummary: vi.fn(async () => undefined),
    };
    const analysisPlan = {
      schemaVersion: "1.0",
      analysisPlanId: `analysis-${"c".repeat(16)}`,
      sourcePlanId: `plan-${"d".repeat(16)}`,
      sourcePlanFingerprint: "a".repeat(64),
      ontologyVersion: "v1",
      schemaFingerprint: "b".repeat(64),
      status: "ready",
      operation: "ranked_comparison",
      visualization: "bar",
      maxRows: 5,
      guardrails: ["READ_ONLY_SOURCE_PLAN", "NO_ARBITRARY_CODE", "NO_ARBITRARY_SQL", "NO_CAUSAL_CLAIMS"],
      ruleEffects: [{
        ruleId: "business.defect_created_count.creation_time",
        kind: "require",
        code: "BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time",
      }],
    };
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        analysisPlan,
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(false),
      runtimeStore,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    await runtime.invoke({
      body: {
        runId: "run-analysis-1",
        threadId: "thread-analysis-1",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-1"),
        messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }],
      },
    });

    expect(runtimeStore.writeThreadCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({ governedAnalysisPlan: analysisPlan }),
    }));
    expect(runtimeStore.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-analysis-1",
      threadId: "thread-analysis-1",
      type: "governed-analysis-plan-ready",
      analysisPlan,
    }));
    expect(runtimeStore.appendRunSummary).toHaveBeenCalledWith(expect.objectContaining({
      businessRuleCodes: ["BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time"],
    }));
  });

  it("persists a failure audit event when a graph run throws before finalize", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const actor = analyticsActor("scope-1");
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockRejectedValue(new Error("analytics context unavailable")),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(false),
      runtimeStore,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    await expect(runtime.invoke({
      body: {
        runId: "run-fail-1",
        threadId: "thread-fail-1",
        useAnalyticsContext: true,
        actor,
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
    })).rejects.toThrow("analytics context unavailable");

    expect(runtimeStore.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-fail-1",
      threadId: "thread-fail-1",
      actorScope: actor,
      type: "agent-runtime-failed",
      error: expect.objectContaining({ message: "analytics context unavailable" }),
    }));
  });

  it("retries one transient tool failure and persists the recovery decision", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const toolCall = { id: "retry-call-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } };
    const executeToolCall = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("analytics temporarily unavailable"), { statusCode: 503, retryable: true }))
      .mockResolvedValueOnce({
        contextText: "# Main agent semantic tool result\nResult: recovered",
        toolMessage: { role: "tool", tool_call_id: "retry-call-1", name: "query_semantic_metrics", content: '{"ok":true}' },
      });
    const toolRecoveryWait = vi.fn().mockResolvedValue(undefined);
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion: vi
        .fn()
        .mockResolvedValueOnce({ content: "", toolCalls: [toolCall] })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
      executeToolCall,
      runtimeStore,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        runId: "run-retry-1",
        threadId: "thread-retry-1",
        useAnalyticsContext: true,
        actor: analyticsActor("scope-retry"),
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
      toolDependencies: { toolRecoveryWait, toolRecoveryRandom: () => 0 },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(toolRecoveryWait).toHaveBeenCalledWith(50);
    expect(result.mainAgentToolContext.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-recovery",
      toolCallId: "retry-call-1",
      recovery: expect.objectContaining({
        action: "retry",
        attempts: 2,
        outcome: "recovered",
        queryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    expect(runtimeStore.appendToolAudit).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "retry-call-1",
      recovery: expect.objectContaining({
        action: "retry",
        attempts: 2,
        outcome: "recovered",
        queryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
  });

  it("removes unexecuted batch calls and raw inputs after terminal schema recovery", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const firstToolCall = {
      id: "schema-call",
      type: "function",
      function: { name: "query_analytics", arguments: '{"apiKey":"recovery-audit-secret"}' },
    };
    const secondToolCall = {
      id: "queued-call",
      type: "function",
      function: { name: "query_dashboard_summary", arguments: "{}" },
    };
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "schema-call",
        name: "query_analytics",
        content: JSON.stringify({ ok: false, tool: "query_analytics", failure: { code: "AGENT_ANALYTICS_SCHEMA_INVALID", statusCode: 400 } }),
      },
      contextText: "# Main agent tool result\nResult: unavailable",
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion: vi.fn().mockResolvedValue({ content: "", toolCalls: [firstToolCall, secondToolCall] }),
      executeToolCall,
      runtimeStore,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        runId: "run-schema-recovery",
        threadId: "thread-schema-recovery",
        useAnalyticsContext: true,
        actor: analyticsActor("scope-schema-recovery"),
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(result.mainAgentToolContext.toolCalls).toEqual([firstToolCall]);
    expect(result.finalMessages).toEqual([{ role: "user", content: "DTSV 6月份提了多少bug？" }]);
    const recoveryAudit = runtimeStore.appendToolAudit.mock.calls
      .map(([audit]) => audit)
      .find((audit) => audit.toolCallId === "schema-call");
    expect(recoveryAudit).toEqual(expect.objectContaining({
      toolCallId: "schema-call",
      recovery: expect.objectContaining({ queryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/) }),
    }));
    expect(recoveryAudit).not.toHaveProperty("input");
    expect(JSON.stringify(runtimeStore.appendToolAudit.mock.calls)).not.toContain("recovery-audit-secret");
  });

  it("runs one catalog-verified detected-by alias retry after empty analytics diagnosis", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const originalToolCall = {
      id: "graph-alias-source",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "aggregate",
          metrics: ["defect_count"],
          dimensions: [],
          filters: { years: ["2026"], detected_by: ["Size Li"], problem_finder_teams: ["DTSV_China"] },
          time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
          limit: 20,
        }),
      },
    };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [originalToolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.id === "graph-alias-source") {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "query_analytics",
            content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [], returned_groups: 0 } }),
          },
          contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: none",
        };
      }
      if (toolCall.function.name === "diagnose_analytics_empty") {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "diagnose_analytics_empty",
            content: JSON.stringify({
              ok: true,
              tool: "diagnose_analytics_empty",
              result: {
                causeCode: "FILTER_VALUE_ALIAS",
                retryQuery: {
                  dataset: "defects",
                  intent: "aggregate",
                  metrics: ["defect_count"],
                  dimensions: [],
                  filters: { years: ["2026"], detected_by: ["Li Size"], problem_finder_teams: ["DTSV_China"] },
                  time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
                  limit: 20,
                },
                candidateValues: [{ field: "detected_by", value: "Li Size", count: 12 }],
              },
            }),
          },
          contextText: "# Main agent tool result\nTool: diagnose_analytics_empty\nCause: FILTER_VALUE_ALIAS",
        };
      }
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "query_analytics",
          content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [{ defect_count: 12 }], returned_groups: 1 } }),
        },
        contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: 1",
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      runtimeStore,
      now: () => new Date("2026-08-05T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-alias-retry",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-alias-retry"),
        messages: [{ role: "user", content: "Size Li 今年提票情况" }],
      },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(3);
    expect(result.mainAgentToolContext.toolCalls.map((toolCall) => toolCall.function.name)).toEqual([
      "query_analytics",
      "diagnose_analytics_empty",
      "query_analytics",
    ]);
    expect(JSON.parse(executeToolCall.mock.calls[2][0].function.arguments)).toMatchObject({
      filters: { years: ["2026"], detected_by: ["Li Size"], problem_finder_teams: ["DTSV_China"] },
    });
    expect(result.mainAgentToolContext.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-recovery",
      toolCallId: "graph-alias-source-catalog-retry",
      recovery: expect.objectContaining({
        action: "catalog",
        reason: "filter_value_alias",
        outcome: "recovered",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    const retryAudit = runtimeStore.appendToolAudit.mock.calls
      .map(([audit]) => audit)
      .find((audit) => audit.toolCallId === "graph-alias-source-catalog-retry");
    expect(retryAudit).toEqual(expect.objectContaining({
      toolCallId: "graph-alias-source-catalog-retry",
      recovery: expect.objectContaining({
        sourceToolCallId: "graph-alias-source",
        diagnosisToolCallId: "graph-alias-source-diagnosis",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        outcome: "recovered",
      }),
    }));
    expect(retryAudit).not.toHaveProperty("input");
  });

  it("retries a semantic schema failure from one scope-bound governed plan step", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
    const originalToolCall = {
      id: "semantic-plan-source",
      type: "function",
      function: { name: "query_semantic_metrics", arguments: JSON.stringify({ query: { metricIds: ["quality.defect_density"] } }) },
    };
    const canonicalArgs = {
      query: {
        schemaVersion: "1.0",
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        intent: "aggregate",
        entityIds: ["quality.defect"],
        metricIds: ["defect.count"],
        dimensionIds: [],
        filters: [{ dimensionId: "org.problem_finder_team", operator: "in", values: ["DTSV_China"], source: "policy" }],
        timeScopes: [],
        comparison: null,
        sort: [],
        limit: 20,
      },
    };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [originalToolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.id === "semantic-plan-source") {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "query_semantic_metrics",
            content: JSON.stringify({
              ok: false,
              tool: "query_semantic_metrics",
              failure: { code: "ONTOLOGY_METRIC_NOT_APPROVED", statusCode: 400 },
            }),
          },
          contextText: "# Main agent tool result\nTool: query_semantic_metrics\nResult: unavailable",
        };
      }
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "query_semantic_metrics",
          content: JSON.stringify({ ok: true, tool: "query_semantic_metrics", result: { summary: { metrics: { "defect.count": 12 } } } }),
        },
        contextText: "# Main agent semantic tool result\nTool: query_semantic_metrics\ndefect.count: 12",
      };
    });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        skipDefectContext: false,
        queryPlan: {
          status: "valid",
          actorScopeHash: "scope-a",
          planId: "plan-semantic-retry",
          steps: [{ toolName: "query_semantic_metrics", canonicalArgs }],
        },
      }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall,
      runtimeStore,
      now: () => new Date("2026-08-05T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        threadId: "thread-semantic-plan-retry",
        useAnalyticsContext: true,
          actor: analyticsActor("scope-a", "alice"),
        messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }],
      },
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls[1][0]).toMatchObject({
      id: "semantic-plan-source-governed-plan-retry",
      function: { name: "query_semantic_metrics" },
    });
    expect(JSON.parse(executeToolCall.mock.calls[1][0].function.arguments)).toEqual(canonicalArgs);
    expect(result.mainAgentToolContext.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-recovery",
      toolCallId: "semantic-plan-source-governed-plan-retry",
      recovery: expect.objectContaining({
        action: "catalog",
        reason: "governed_query_plan",
        outcome: "recovered",
        sourcePlanId: "plan-semantic-retry",
      }),
    }));
    const retryAudit = runtimeStore.appendToolAudit.mock.calls
      .map(([audit]) => audit)
      .find((audit) => audit.toolCallId === "semantic-plan-source-governed-plan-retry");
    expect(retryAudit).toEqual(expect.objectContaining({
      recovery: expect.objectContaining({
        sourcePlanId: "plan-semantic-retry",
        sourceToolCallId: "semantic-plan-source",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    expect(retryAudit).not.toHaveProperty("input");
  });

  it("carries a valid analysis ref into the next same-scope thread turn and resets the tool budget", async () => {
    const metricToolCall = { id: "metric-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [metricToolCall], answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "Done.", toolCalls: [], answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "No tool needed.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const semanticPayload = {
      ontologyVersion: "v1",
      schemaFingerprint: "f".repeat(64),
      analysisRef: "analysis-1",
      sourceRevision: { revisionId: "snap-1", status: "pinned" },
      scope: { actorScopeHash: "scope-a", filters: [] },
      quality: { completeness: "complete", warnings: [] },
      evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
    };
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false }),
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      executeToolCall: vi.fn().mockResolvedValue({
        contextText: "# Semantic result",
        toolMessage: {
          role: "tool",
          tool_call_id: "metric-1",
          name: "query_semantic_metrics",
          content: JSON.stringify({ ok: true, tool: "query_semantic_metrics", result: semanticPayload }),
        },
      }),
      maxToolSteps: 2,
      now: () => new Date("2026-08-03T08:00:00.000Z"),
    });
    const actor = analyticsActor("scope-a", "alice");

    const first = await runtime.invoke({
      body: { threadId: "thread-continuation", useAnalyticsContext: true, actor, messages: [{ role: "user", content: "按 ECU 排名" }] },
    });
    const second = await runtime.invoke({
      body: { threadId: "thread-continuation", useAnalyticsContext: true, actor, messages: [{ role: "user", content: "显示 HU 的缺陷明细" }] },
    });

    expect(first.metrics.evidenceGate).toMatchObject({ status: "pass", analysisRefs: ["analysis-1"] });
    expect(first.context).toContain("Status: PASS");
    expect(first.context).toContain("# Citation contract");
    expect(first.context).toContain("Allowed toolCallIds: metric-1");
    expect(requestToolCompletion).toHaveBeenCalledTimes(3);
    expect(requestToolCompletion.mock.calls[2][0].context).toContain("analysis_ref: analysis-1");
    expect(requestToolCompletion.mock.calls[2][0].context).toContain("source_revision: snap-1");
    expect(second.metrics.mainAgentToolCallCount).toBe(0);
  });
});
