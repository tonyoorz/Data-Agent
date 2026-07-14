import { describe, expect, it, vi } from "vitest";

import {
  resolveMainAgentToolContext,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolLoop.mjs";

describe("main agent tool loop", () => {
  it("plans tools only for likely dashboard metric questions", () => {
    expect(shouldPlanMainAgentTools([{ role: "user", content: "DTSV 6月份提了多少bug？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "请润色这段话" }])).toBe(false);
  });

  it("runs planned tool calls and returns factual context", async () => {
    const toolCalls = [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "query_dashboard_summary",
          arguments: '{"filters":{"years":2026}}',
        },
      },
    ];
    const requestChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls, answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "No more tools.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "call-1",
        name: "query_dashboard_summary",
        content: '{"ok":true}',
      },
      contextText: "# Main agent tool result\nTool: query_dashboard_summary\nResult: 12 defects",
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      model: "deepseek-v4-flash",
      context: "# Analytics business context",
      requestChatCompletion,
      executeToolCall,
      toolDependencies: { runDuplicateBridge: "bridge" },
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.model).toBe("deepseek-v4-flash");
    expect(requestArgs.toolChoice).toBe("auto");
    expect(requestArgs.context).toContain("query_defect_high_frequency_analysis");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_dashboard_summary",
    );
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledWith(toolCalls[0], { runDuplicateBridge: "bridge" });
    expect(resolved.contextText).toContain("Result: 12 defects");
    expect(resolved.toolCalls).toEqual(toolCalls);
    expect(resolved.toolEvents).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "query_dashboard_summary",
        input: { filters: { years: 2026 } },
      },
      {
        type: "tool-output-available",
        toolCallId: "call-1",
        toolName: "query_dashboard_summary",
        outputSummary: "# Main agent tool result\nTool: query_dashboard_summary\nResult: 12 defects",
      },
    ]);
    expect(resolved.toolConversationMessages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: toolCalls,
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "query_dashboard_summary",
        content: '{"ok":true}',
      },
    ]);
  });

  it("uses an injected tool list for policy-filtered legacy planning", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({ content: "No tool needed.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const tools = [{ type: "function", function: { name: "query_dashboard_summary", parameters: { type: "object", properties: {}, additionalProperties: false } } }];

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
      tools,
    });

    expect(requestChatCompletion.mock.calls[0][0].tools).toBe(tools);
    expect(requestChatCompletion.mock.calls[0][0].context).not.toContain("ask_clarification");
    expect(requestChatCompletion.mock.calls[0][0].context).not.toContain("get_data_catalog");
    expect(requestChatCompletion.mock.calls[0][0].context).not.toContain("resolve_business_terms");
  });

  it("fails fast on malformed tool execution results", async () => {
    const toolCalls = [{ id: "call-1", type: "function", function: { name: "query_dashboard_summary", arguments: '{"filters":{}}' } }];
    await expect(resolveMainAgentToolContext({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestChatCompletion: vi.fn().mockResolvedValue({ content: "", toolCalls, answerModel: "deepseek-v4-flash" }),
      executeToolCall: vi.fn().mockResolvedValue({ contextText: "missing tool message" }),
    })).rejects.toThrow(/Invalid tool result shape/);
  });

  it("continues planning with prior tool results until the model stops calling tools", async () => {
    const firstToolCalls = [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "query_defect_high_frequency_analysis",
          arguments: '{"filters":{"recent_days":7}}',
        },
      },
    ];
    const secondToolCalls = [
      {
        id: "call-2",
        type: "function",
        function: {
          name: "query_full_picture_module",
          arguments: '{"module":"dashboard_tickets","filters":{"assigned_ecus":["HU-H"]},"page_size":5}',
        },
      },
    ];
    const requestChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: firstToolCalls, answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "", toolCalls: secondToolCalls, answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "Enough data.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi
      .fn()
      .mockResolvedValueOnce({
        toolMessage: {
          role: "tool",
          tool_call_id: "call-1",
          name: "query_defect_high_frequency_analysis",
          content: '{"top":"HU-H"}',
        },
        contextText: "# Main agent tool result\nTool: query_defect_high_frequency_analysis\n1. HU-H: 5",
      })
      .mockResolvedValueOnce({
        toolMessage: {
          role: "tool",
          tool_call_id: "call-2",
          name: "query_full_picture_module",
          content: '{"rows":5}',
        },
        contextText: "# Main agent tool result\nTool: query_full_picture_module\ndashboard_tickets: 5 rows",
      });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "最近一周缺陷集中在哪些 ECU？再看 top ECU 的 ticket" }],
      requestChatCompletion,
      executeToolCall,
      maxSteps: 4,
    });

    expect(requestChatCompletion).toHaveBeenCalledTimes(3);
    expect(requestChatCompletion.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "最近一周缺陷集中在哪些 ECU？再看 top ECU 的 ticket" },
      { role: "assistant", content: "", tool_calls: firstToolCalls },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "query_defect_high_frequency_analysis",
        content: '{"top":"HU-H"}',
      },
    ]);
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(resolved.toolCalls).toEqual([...firstToolCalls, ...secondToolCalls]);
    expect(resolved.contextText).toContain("HU-H: 5");
    expect(resolved.contextText).toContain("dashboard_tickets: 5 rows");
  });

  it("stops iterative planning at maxSteps", async () => {
    const loopingToolCall = {
      id: "loop-call",
      type: "function",
      function: {
        name: "query_dashboard_summary",
        arguments: '{"filters":{"years":2026}}',
      },
    };
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "",
      toolCalls: [loopingToolCall],
      answerModel: "deepseek-v4-flash",
    });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "loop-call",
        name: "query_dashboard_summary",
        content: '{"ok":true}',
      },
      contextText: "# Main agent tool result\nTool: query_dashboard_summary\nResult: 1 defects",
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "循环调用测试" }],
      requestChatCompletion,
      executeToolCall,
      maxSteps: 2,
    });

    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(resolved.stoppedReason).toBe("max_steps");
    expect(resolved.toolCalls).toHaveLength(2);
  });

  it("stops planning when clarification is requested", async () => {
    const clarificationToolCall = {
      id: "clarify-1",
      type: "function",
      function: {
        name: "ask_clarification",
        arguments: '{"question":"要看哪个项目？","options":["SP25","全部项目"]}',
      },
    };
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "",
      toolCalls: [clarificationToolCall],
      answerModel: "deepseek-v4-flash",
    });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "clarify-1",
        name: "ask_clarification",
        content: '{"question":"要看哪个项目？","options":["SP25","全部项目"]}',
      },
      contextText: "# Main agent tool result\nTool: ask_clarification\nQuestion: 要看哪个项目？",
      requiresUserInput: true,
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "帮我分析一下趋势" }],
      requestChatCompletion,
      executeToolCall,
      maxSteps: 4,
    });

    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(resolved.stoppedReason).toBe("clarification_requested");
    expect(resolved.contextText).toContain("Question: 要看哪个项目？");
  });

  it("does not return tool context when the model answers without tool calls", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });
    const executeToolCall = vi.fn();

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "DTSV 当前风险怎么看？" }],
      requestChatCompletion,
      executeToolCall,
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(resolved.contextText).toBe("");
    expect(resolved.toolCalls).toEqual([]);
    expect(resolved.toolConversationMessages).toEqual([]);
  });

  it("tells the planner how to handle recent-week high-frequency defect questions", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "缺陷高频分析里，最近一周新增缺陷集中在哪些 ECU？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("recent_days: 7");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_defect_high_frequency_analysis",
    );
  });

  it("tells the planner to use the generic module tool as a Full Picture fallback", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "Full Picture 里这个问题按项目趋势怎么看？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("query_full_picture_module");
    expect(requestArgs.context).toContain("fallback");
    expect(requestArgs.context).toContain("ask_clarification");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_full_picture_module",
    );
  });
});