import { describe, expect, it, vi } from "vitest";

import {
  resolveMainAgentToolContext,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolLoop.mjs";

describe("main agent tool loop", () => {
  it("plans tools only for likely dashboard metric questions", () => {
    expect(shouldPlanMainAgentTools([{ role: "user", content: "DTSV 6月份提了多少bug？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块并给出根因假设。" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "octane_defects 按 solution_cluster 或 assigned_ecu" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "现在 ontology 里哪些能力是 available？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "基于这个 Octane ticket https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=2774806 创建测试用例" }])).toBe(true);
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

  it("tells the planner to fetch ontology context before drafting test cases", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "基于 T-ONTO-1 帮我创建一个回归测试用例" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("get_test_case_context");
    expect(requestArgs.context).toContain("before drafting");
    expect(requestArgs.context).toContain("call get_test_case_context first");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "get_test_case_context",
    );
  });

  it("tells the planner to extract defect ids from Octane ticket URLs", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "基于这个ticket https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=2774806 创建测试用例" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("Octane ticket URL");
    expect(requestArgs.context).toContain("id=2774806");
    expect(requestArgs.context).toContain("defect_id");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "get_test_case_context",
    );
  });

  it("tells the planner to use ontology catalog for capability discovery", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "现在 ontology 里哪些实体和能力是 available？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("get_ontology_catalog");
    expect(requestArgs.context).toContain("capability states");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "get_ontology_catalog",
    );
  });

  it("tells the planner to use Octane field search for schema discovery", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "Octane defect 里 DTSV 和车系分别对应哪些 API 字段？后面能不能更新？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("search_octane_fields");
    expect(requestArgs.context).toContain("top-k field candidates");
    expect(requestArgs.context).toContain("Do not load the full Octane field catalog into the prompt");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "search_octane_fields",
    );
  });

  it("tells the planner to use Action Ontology for write and delete capability checks", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "Octane defect 字段能不能更新？能不能删除缺陷单？" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("Action Ontology");
    expect(requestArgs.context).toContain("write/update/delete");
    expect(requestArgs.context).toContain("disabled or blocked actions must not be executed");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "get_ontology_catalog",
    );
  });

  it("tells the planner to use governed semantic tools for analytics metrics", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("query_semantic_metrics");
    expect(requestArgs.context).toContain("governed Ontology");
    expect(requestArgs.context).toContain("Never redefine metrics");
    expect(requestArgs.context.indexOf("query_semantic_metrics first")).toBeLessThan(
      requestArgs.context.indexOf("query_defect_aggregate only as a legacy analytics fallback"),
    );
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_semantic_metrics",
    );
  });

  it("tells the planner to use governed semantic records for list and drilldown requests", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "列出最近一周 DTSV 新增缺陷明细" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("query_semantic_records");
    expect(requestArgs.context).toContain("list or drilldown");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_semantic_records",
    );
  });

  it("tells the planner to use governed traceability for lineage questions", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "追溯 Requirement 到 TestCase、TestRun 和 Defect 的链路" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("query_traceability");
    expect(requestArgs.context).toContain("requirement, testcase, test-run, and defect lineage");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_traceability",
    );
  });

  it("tells the planner to use defect aggregate for Top Issue growth questions", async () => {
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "No tool needed.",
      toolCalls: [],
      answerModel: "deepseek-v4-flash",
    });

    await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块并给出根因假设。" }],
      requestChatCompletion,
      executeToolCall: vi.fn(),
    });

    const requestArgs = requestChatCompletion.mock.calls[0][0];
    expect(requestArgs.context).toContain("query_defect_aggregate");
    expect(requestArgs.context).toContain("Top Issue");
    expect(requestArgs.context).toContain("comparison");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_defect_aggregate",
    );
  });
});