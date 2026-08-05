import { describe, expect, it, vi } from "vitest";

import { runMainAgentToolTurn } from "../../../server/mainAgentToolOrchestrator.mjs";

describe("main agent tool orchestrator", () => {
  it("emits standard turn and tool lifecycle events", async () => {
    const toolCall = { id: "call-1", type: "function", function: { name: "query_analytics", arguments: "{}" } };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [toolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_analytics", content: "{}" },
      contextText: "# Main agent tool result\nTool: query_analytics\nResult: 1",
    });

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestToolCompletion,
      executeToolCall,
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent.turn.started",
      "agent.tool.planned",
      "agent.tool.started",
      "agent.tool.completed",
      "agent.turn.completed",
    ]));
    expect(result.uiToolEvents.map((event) => event.type)).toEqual(["tool-input-available", "tool-output-available"]);
    expect(result.contextText).toContain("Result: 1");
  });

  it("uses the shared bounded retry policy for transient read failures", async () => {
    const toolCall = { id: "retry-call", type: "function", function: { name: "query_analytics", arguments: "{}" } };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [toolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary analytics outage"), { statusCode: 503, retryable: true }))
      .mockResolvedValueOnce({
        toolMessage: { role: "tool", tool_call_id: "retry-call", name: "query_analytics", content: '{"ok":true}' },
        contextText: "# Main agent tool result\nTool: query_analytics\nResult: recovered",
      });
    const toolRecoveryWait = vi.fn().mockResolvedValue(undefined);

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestToolCompletion,
      executeToolCall,
      toolDependencies: { toolRecoveryWait, toolRecoveryRandom: () => 0 },
      runId: "run-retry",
      threadId: "thread-retry",
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(toolRecoveryWait).toHaveBeenCalledWith(50);
    expect(result.uiToolEvents).toContainEqual(expect.objectContaining({
      type: "tool-recovery",
      toolCallId: "retry-call",
      recovery: expect.objectContaining({ action: "retry", outcome: "recovered" }),
    }));
  });

  it("stops the current turn on schema recovery instead of executing queued tools", async () => {
    const firstToolCall = { id: "schema-call", type: "function", function: { name: "query_analytics", arguments: "{}" } };
    const secondToolCall = { id: "queued-call", type: "function", function: { name: "query_dashboard_summary", arguments: "{}" } };
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "schema-call",
        name: "query_analytics",
        content: JSON.stringify({ ok: false, tool: "query_analytics", failure: { code: "UNSUPPORTED_DEFECT_FILTER", statusCode: 400 } }),
      },
      contextText: "# Main agent tool result\nResult: unavailable",
    });

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestToolCompletion: vi.fn().mockResolvedValue({ content: "", toolCalls: [firstToolCall, secondToolCall] }),
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(result.stoppedReason).toBe("tool_recovery_catalog");
    expect(result.contextText).toContain("governed field or filter-value retrieval");
    expect(result.toolCalls).toEqual([firstToolCall]);
    expect(result.toolConversationMessages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "", tool_calls: [firstToolCall] },
    ]));
    expect(result.toolConversationMessages).not.toEqual(expect.arrayContaining([
      { role: "assistant", content: "", tool_calls: [firstToolCall, secondToolCall] },
    ]));
  });

  it("retries one catalog-verified detected-by alias after an empty diagnosis", async () => {
    const originalToolCall = {
      id: "alias-source",
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
      if (toolCall.id === "alias-source") {
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

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "Size Li 今年提票情况" }],
      requestToolCompletion,
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(3);
    expect(result.toolCalls.map((toolCall) => toolCall.function.name)).toEqual([
      "query_analytics",
      "diagnose_analytics_empty",
      "query_analytics",
    ]);
    expect(executeToolCall.mock.calls[2][0]).toMatchObject({
      id: "alias-source-catalog-retry",
      function: { name: "query_analytics" },
    });
    expect(JSON.parse(executeToolCall.mock.calls[2][0].function.arguments)).toMatchObject({
      filters: { years: ["2026"], detected_by: ["Li Size"], problem_finder_teams: ["DTSV_China"] },
    });
    expect(result.uiToolEvents).toContainEqual(expect.objectContaining({
      type: "tool-recovery",
      toolCallId: "alias-source-catalog-retry",
      recovery: expect.objectContaining({
        action: "catalog",
        reason: "filter_value_alias",
        outcome: "recovered",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
  });
});