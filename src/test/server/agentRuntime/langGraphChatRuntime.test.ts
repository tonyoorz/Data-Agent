import { describe, expect, it, vi } from "vitest";

import {
  createLangGraphChatRuntime,
  resolveAgentRuntimeMode,
} from "../../../../server/agentRuntime/langGraphChatRuntime.mjs";
import { fingerprintQueryPlanSteps } from "../../../../server/ontology/queryPlanner.mjs";

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
          actor: {
            actorId: "u1",
            scopeHash: "scope-1",
            scopes: {
              workspaceIds: ["DTSV"],
              allowedObjectTypes: ["quality.defect"],
            },
          },
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
        messages: [{ role: "user", content: "DTSV 缺陷数按 ECU 排名" }],
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
    expect(result.mainAgentToolContext).toMatchObject({
      stoppedReason: "deterministic_plan_complete",
      toolCalls: [expect.objectContaining({ id: "plan-direct-1:s1" })],
    });
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

  it("does not resolve data context or plan tools without a tenant-scoped actor", async () => {
    const resolveAnalyticsContext = vi.fn().mockResolvedValue({ contextText: "# Analytics", skipDefectContext: false });
    const requestToolCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [] });
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext,
      resolveDefectContext: vi.fn(),
      shouldPlanTools: vi.fn().mockReturnValue(true),
      requestToolCompletion,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const result = await runtime.invoke({
      body: {
        useAnalyticsContext: true,
        actor: { actorId: "internal", scopeHash: "scope" },
        messages: [{ role: "user", content: "DTSV 有多少缺陷？" }],
      },
    });

    expect(result.directResponse).toEqual(expect.objectContaining({ intent: "data_access_unavailable" }));
    expect(resolveAnalyticsContext).not.toHaveBeenCalled();
    expect(requestToolCompletion).not.toHaveBeenCalled();
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
          scopes: {
            projectIds: ["App"],
            teamIds: ["DTSV_China"],
            allowedObjectTypes: ["quality.defect"],
          },
        },
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
      toolDependencies: { analyticsFetch: "fetch" },
    });

    expect(result.runId).toBe("run-123");
    expect(result.actorScope).toEqual({
      actorId: "u1",
      scopeHash: "scope-1",
      scopes: {
        projectIds: ["App"],
        teamIds: ["DTSV_China"],
        allowedObjectTypes: ["quality.defect"],
      },
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
  });

  it("persists governed analysis plan provenance in runtime audit records", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
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
        actor: {
          actorId: "u1",
          scopeHash: "scope-1",
          scopes: {
            workspaceIds: ["DTSV"],
            allowedObjectTypes: ["quality.defect"],
          },
        },
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
  });

  it("persists a failure audit event when a graph run throws before finalize", async () => {
    const runtimeStore = {
      appendRunEvent: vi.fn(async () => undefined),
      writeThreadCheckpoint: vi.fn(async () => undefined),
      appendToolAudit: vi.fn(async () => undefined),
    };
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
        actor: {
          actorId: "u1",
          scopeHash: "scope-1",
          scopes: {
            workspaceIds: ["DTSV"],
            allowedObjectTypes: ["quality.defect"],
          },
        },
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
    })).rejects.toThrow("analytics context unavailable");

    expect(runtimeStore.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-fail-1",
      threadId: "thread-fail-1",
      actorScope: {
        actorId: "u1",
        scopeHash: "scope-1",
        scopes: {
          workspaceIds: ["DTSV"],
          allowedObjectTypes: ["quality.defect"],
        },
      },
      type: "agent-runtime-failed",
      error: expect.objectContaining({ message: "analytics context unavailable" }),
    }));
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
    const actor = {
      actorId: "alice",
      scopeHash: "scope-a",
      scopes: {
        workspaceIds: ["DTSV"],
        allowedObjectTypes: ["quality.defect"],
      },
    };

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
