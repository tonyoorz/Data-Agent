import { describe, expect, it, vi } from "vitest";

import {
  resolveMainAgentToolContext,
} from "../../../server/mainAgentToolLoop.mjs";
import {
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolPlanning.mjs";

describe("main agent tool loop", () => {
  const toolNames = (tools: Array<{ function?: { name?: string } }>) => tools.map((tool) => tool.function?.name);

  it("selects a compact semantic metric toolset for metric questions", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }]);
    const names = toolNames(selected.tools);

    expect(selected.intent).toBe("metric_query");
    expect(selected.confidence).toBeGreaterThanOrEqual(0.8);
    expect(selected.reason).toContain("metric");
    expect(selected.requiredSlots).toEqual(expect.arrayContaining(["metric", "time_window"]));
    expect(selected.toolNames).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_semantic_metrics", "ask_clarification"]));
    expect(names).not.toContain("search_duplicates");
    expect(names).not.toContain("get_test_case_context");
    expect(names).not.toContain("search_octane_fields");
    expect(names.length).toBeLessThanOrEqual(8);
  });

  it("does not plan analytics tools for a vague testing-status question", () => {
    const messages = [{ role: "user", content: "测试怎么样" }];
    const selected = selectMainAgentToolset(messages);

    expect(shouldPlanMainAgentTools(messages)).toBe(false);
    expect(selected).toMatchObject({
      intent: "clarification",
      policyHints: ["direct_response", "no_tools", "clarification_required"],
      toolNames: [],
    });
  });

  it("exposes testing coverage tools for coverage threshold questions", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "覆盖率低于70%的模块有哪些？请按业务影响排序，并建议本周补测顺序" }]);
    const clarification = selectMainAgentToolset([{ role: "user", content: "测试执行覆盖率 — manual-run 的通过率/执行率（按模块/ECU 统计）" }]);
    const aidaCoverage = selectMainAgentToolset([{ role: "user", content: "测试执行覆盖率 AIDA 低于70% 关联缺陷数量 排序" }]);

    expect(selected.intent).toBe("coverage_query");
    expect(selected.toolNames).toContain("query_testing_coverage_project_status");
    expect(selected.toolNames).toContain("query_testing_coverage_aida_status");
    expect(clarification.intent).toBe("coverage_query");
    expect(clarification.toolNames).toContain("query_testing_coverage_project_status");
    expect(clarification.toolNames).toContain("query_testing_coverage_aida_status");
    expect(aidaCoverage.intent).toBe("coverage_query");
    expect(aidaCoverage.toolNames).toContain("query_testing_coverage_aida_status");
    expect(aidaCoverage.toolNames).toContain("query_analytics");
  });

  it("routes internal test-group efficiency and defect discovery to FV coverage analysis", () => {
    const selected = selectMainAgentToolset([
      { role: "user", content: "对比 DTSV_China 内部测试小组的执行效率与缺陷发现率" },
    ]);

    expect(selected.intent).toBe("coverage_query");
    expect(selected.toolNames).toContain("query_testing_team_fv_analysis");
  });

  it("exposes governed fallback only for analytics toolsets", () => {
    const analyticsQueries = [
      "最近一周 DTSV 新增缺陷按 ECU Top 5",
      "覆盖率低于70%的模块有哪些？",
      "列出最近一周新增缺陷 ticket 明细",
      "缺陷高频分析里最近一周新增缺陷集中在哪些 ECU？",
      "Full Picture dashboard ticket 按项目怎么看？",
    ];

    for (const query of analyticsQueries) {
      expect(selectMainAgentToolset([{ role: "user", content: query }]).toolNames, query).toContain("query_analytics_fallback");
      expect(selectMainAgentToolset([{ role: "user", content: query }]).toolNames, query).toContain("search_analytics_filter_values");
    }

    expect(selectMainAgentToolset([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }]).toolNames).not.toContain("query_analytics_fallback");
    expect(selectMainAgentToolset([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }]).toolNames).not.toContain("search_analytics_filter_values");
    expect(selectMainAgentToolset([{ role: "user", content: "Octane defect 字段能不能更新？" }]).toolNames).not.toContain("query_analytics_fallback");
    expect(selectMainAgentToolset([{ role: "user", content: "Octane defect 字段能不能更新？" }]).toolNames).not.toContain("search_analytics_filter_values");
  });

  it("selects action and schema tools for write capability questions", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "Octane defect 字段能不能更新？能不能删除缺陷单？" }]);
    const names = toolNames(selected.tools);

    expect(selected.intent).toBe("action_capability");
    expect(selected.policyHints).toEqual(expect.arrayContaining(["use_action_ontology", "block_disabled_or_blocked_actions"]));
    expect(names).toEqual(expect.arrayContaining(["get_ontology_catalog", "search_octane_fields", "ask_clarification"]));
    expect(names).not.toContain("query_semantic_metrics");
    expect(names).not.toContain("search_duplicates");
    expect(names.length).toBeLessThan(7);
  });

  it("selects duplicate tools without exposing analytics query tools", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }]);
    const names = toolNames(selected.tools);

    expect(selected.intent).toBe("duplicate_search");
    expect(names).toEqual(expect.arrayContaining(["search_duplicates", "ask_clarification"]));
    expect(names).not.toContain("query_semantic_metrics");
    expect(names).not.toContain("query_full_picture_module");
    expect(names.length).toBeLessThan(6);
  });

  it("plans tools only for likely dashboard metric questions", () => {
    expect(shouldPlanMainAgentTools([{ role: "user", content: "DTSV 6月份提了多少bug？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块并给出根因假设。" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "octane_defects 按 solution_cluster 或 assigned_ecu" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "现在 ontology 里哪些能力是 available？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "基于这个 Octane ticket https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=2774806 创建测试用例" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "Size Li 今年提票情况" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "这个数据为什么为空？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "请润色这段话" }])).toBe(false);
  });

  it("routes weak person ticket and empty-result wording to analytics tools", () => {
    const personTicket = selectMainAgentToolset([{ role: "user", content: "Size Li 今年提票情况" }]);
    const emptyData = selectMainAgentToolset([{ role: "user", content: "这个数据为什么为空？" }]);

    expect(personTicket.intent).toBe("metric_query");
    expect(personTicket.toolNames).toEqual(expect.arrayContaining(["resolve_business_terms", "query_analytics", "diagnose_analytics_empty"]));
    expect(emptyData.intent).toBe("metric_query");
    expect(emptyData.toolNames).toEqual(expect.arrayContaining(["query_analytics", "diagnose_analytics_empty", "ask_clarification"]));
  });

  it("routes a named defect reporter away from team-only semantic metrics", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "xumiao 提票情况" }]);

    expect(selected.intent).toBe("metric_query");
    expect(selected.requiredSlots).toContain("defect_reporter");
    expect(selected.policyHints).toContain("resolve_defect_reporter_before_aggregate");
    expect(selected.toolNames).toEqual(expect.arrayContaining([
      "resolve_business_terms",
      "search_analytics_filter_values",
      "query_analytics",
      "ask_clarification",
    ]));
    expect(selected.toolNames).not.toContain("query_semantic_metrics");
    expect(selected.toolNames).not.toContain("query_dashboard_summary");
  });

  it("routes broad risk questions to an ontology-backed assessment toolset", () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "DTSV 当前风险怎么看？" }]);

    expect(shouldPlanMainAgentTools([{ role: "user", content: "DTSV 当前风险怎么看？" }])).toBe(true);
    expect(selected.intent).toBe("business_risk_assessment");
    expect(selected.toolNames).toEqual(expect.arrayContaining([
      "get_ontology_catalog",
      "resolve_business_terms",
      "query_semantic_metrics",
      "query_analytics",
      "query_defect_high_frequency_analysis",
      "ask_clarification",
    ]));
    expect(selected.toolNames).not.toContain("query_defect_aggregate");
    expect(selected.toolNames).not.toContain("search_duplicates");
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
    expect(resolved.selectedToolset.intent).toBe("metric_query");
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

  it("blocks model-requested tools outside the selected toolset", async () => {
    const disallowedToolCall = {
      id: "bad-call",
      type: "function",
      function: {
        name: "search_duplicates",
        arguments: '{"query":"DTSV 最近一周新增缺陷"}',
      },
    };
    const requestChatCompletion = vi.fn().mockResolvedValue({
      content: "",
      toolCalls: [disallowedToolCall],
      answerModel: "deepseek-v4-flash",
    });
    const executeToolCall = vi.fn();

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "DTSV 最近一周新增缺陷是多少？" }],
      requestChatCompletion,
      executeToolCall,
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(resolved.stoppedReason).toBe("tool_not_allowed");
    expect(resolved.contextText).toContain("not allowed for intent metric_query");
    expect(resolved.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-blocked",
      toolCallId: "bad-call",
      toolName: "search_duplicates",
      intent: "metric_query",
    }));
  });

  it("blocks a team-only aggregate for a named defect reporter", async () => {
    const teamOnlyToolCall = {
      id: "missing-defect-reporter",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "aggregate",
          metrics: ["defect_count"],
          dimensions: [],
          filters: { problem_finder_teams: ["DTSV_China"] },
          time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
        }),
      },
    };
    const requestChatCompletion = vi.fn().mockResolvedValue({ content: "", toolCalls: [teamOnlyToolCall] });
    const executeToolCall = vi.fn().mockResolvedValue({
      contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: 1",
      toolMessage: {
        role: "tool",
        tool_call_id: "missing-defect-reporter",
        name: "query_analytics",
        content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [{ defect_count: 10 }], returned_groups: 1 } }),
      },
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "xumiao 提票情况" }],
      requestChatCompletion,
      executeToolCall,
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(resolved.stoppedReason).toBe("tool_not_allowed");
    expect(resolved.contextText).toContain("defect_reporter_filter_required");
    expect(resolved.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-blocked",
      toolCallId: "missing-defect-reporter",
      toolName: "query_analytics",
      reason: "defect_reporter_filter_required",
    }));
  });

  it("automatically diagnoses empty query_analytics results before final answer", async () => {
    const analyticsToolCall = {
      id: "analytics-empty",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "aggregate",
          metrics: ["defect_count"],
          dimensions: [],
          filters: { years: ["2026"], detected_by: ["Size Li"] },
          time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
        }),
      },
    };
    const requestChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [analyticsToolCall], answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "No more tools.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function.name === "query_analytics") {
        return {
          toolMessage: {
            role: "tool",
            tool_call_id: toolCall.id,
            name: "query_analytics",
            content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [], returned_groups: 0, total_groups: 0 } }),
          },
          contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: none",
        };
      }
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "diagnose_analytics_empty",
          content: JSON.stringify({ ok: true, tool: "diagnose_analytics_empty", result: { recommendation: "Relax detected_by" } }),
        },
        contextText: "# Main agent tool result\nTool: diagnose_analytics_empty\nRecommendation: Relax detected_by",
      };
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "Size Li 今年提票情况" }],
      requestChatCompletion,
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls[1][0]).toEqual(expect.objectContaining({
      id: "analytics-empty-diagnosis",
      function: expect.objectContaining({ name: "diagnose_analytics_empty" }),
    }));
    expect(JSON.parse(executeToolCall.mock.calls[1][0].function.arguments)).toEqual(expect.objectContaining({
      reason: "query_analytics returned no aggregate rows",
      query: expect.objectContaining({ filters: { years: ["2026"], detected_by: ["Size Li"] } }),
    }));
    expect(resolved.toolCalls.map((toolCall) => toolCall.function.name)).toEqual([
      "query_analytics",
      "diagnose_analytics_empty",
    ]);
    expect(resolved.contextText).toContain("Tool: diagnose_analytics_empty");
    expect(resolved.toolEvents).toContainEqual(expect.objectContaining({
      type: "tool-input-available",
      toolCallId: "analytics-empty-diagnosis",
      toolName: "diagnose_analytics_empty",
    }));
  });

  it("builds evidence envelopes from tool results", async () => {
    const toolCalls = [
      {
        id: "semantic-call",
        type: "function",
        function: {
          name: "query_semantic_metrics",
          arguments: '{"query":{"intent":"aggregate"}}',
        },
      },
    ];
    const requestChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls, answerModel: "deepseek-v4-flash" })
      .mockResolvedValueOnce({ content: "Done.", toolCalls: [], answerModel: "deepseek-v4-flash" });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: {
        role: "tool",
        tool_call_id: "semantic-call",
        name: "query_semantic_metrics",
        content: JSON.stringify({
          ok: true,
          tool: "query_semantic_metrics",
          result: {
            ontologyVersion: "v1",
            schemaFingerprint: "f".repeat(64),
            analysisRef: "analysis-1",
            sourceRevision: { revisionId: "snap-1", status: "pinned" },
            scope: { actorScopeHash: "scope-a" },
            quality: { completeness: "complete", warnings: [] },
            evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
          },
        }),
      },
      contextText: "# Main agent tool result\nTool: query_semantic_metrics\ndefect.count: 3",
    });

    const resolved = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷是多少？" }],
      requestChatCompletion,
      executeToolCall,
    });

    expect(resolved.evidence).toEqual([
      expect.objectContaining({
        tool: "query_semantic_metrics",
        toolCallId: "semantic-call",
        intent: "metric_query",
        ontologyVersion: "v1",
        schemaFingerprint: "f".repeat(64),
        sourceRevision: { revisionId: "snap-1", status: "pinned" },
        quality: { completeness: "complete", warnings: [] },
        analysisRef: "analysis-1",
        scope: { actorScopeHash: "scope-a" },
        evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
      }),
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
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
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
    expect(requestArgs.context).toContain("diagnose_analytics_empty");
    expect(requestArgs.context).toContain("before answering no data");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_defect_high_frequency_analysis",
    );
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_analytics",
    );
  });

  it("tells the planner to use the generic module tool as a Full Picture fallback", async () => {
    const selected = selectMainAgentToolset([{ role: "user", content: "Full Picture 里这个问题按项目趋势怎么看？" }]);
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
    expect(selected.intent).toBe("dashboard_fallback");
    expect(requestArgs.context).toContain("query_full_picture_module");
    expect(requestArgs.context).toContain("fallback");
    expect(requestArgs.context).toContain("query_analytics");
    expect(requestArgs.context).toContain("ask_clarification");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_full_picture_module",
    );
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "diagnose_analytics_empty",
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
      requestArgs.context.indexOf("query_analytics as the canonical high-level tool"),
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

  it("tells the planner to use high-level analytics for Top Issue growth questions", async () => {
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
    expect(requestArgs.context).toContain("query_analytics");
    expect(requestArgs.context).not.toContain("query_defect_aggregate");
    expect(requestArgs.context).toContain("Top Issue");
    expect(requestArgs.context).toContain("comparison");
    expect(requestArgs.context).toContain("query_analytics as the canonical high-level tool");
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "query_analytics",
    );
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain(
      "diagnose_analytics_empty",
    );
    expect(requestArgs.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).not.toContain(
      "query_defect_aggregate",
    );
  });
});
