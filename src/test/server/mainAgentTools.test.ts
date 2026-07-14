import { describe, expect, it, vi } from "vitest";

import {
  executeMainAgentToolCall,
  MAIN_AGENT_TOOLS,
} from "../../../server/mainAgentTools.mjs";

describe("main agent analytics tools", () => {
  it("exposes a typed dashboard summary tool", () => {
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "get_data_catalog",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "resolve_business_terms",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "query_dashboard_summary",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "query_testing_coverage_project_status",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "search_duplicates",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "query_defect_high_frequency_analysis",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "query_full_picture_module",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "ask_clarification",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
  });

  it("executes get_data_catalog without calling data APIs", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "catalog-1",
        type: "function",
        function: {
          name: "get_data_catalog",
          arguments: "{}",
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "catalog-1",
      name: "get_data_catalog",
      content: expect.stringContaining('"datasets"'),
    });
    expect(result.contextText).toContain("Tool: get_data_catalog");
    expect(result.contextText).toContain("defects");
    expect(result.contextText).toContain("testing_coverage");
    expect(result.contextText).toContain("Do not invent fields");
  });

  it("normalizes common QGate business terms without calling data APIs", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "terms-1",
        type: "function",
        function: {
          name: "resolve_business_terms",
          arguments: JSON.stringify({ query: "DTSV 最近一周新增缺陷集中在哪些 ECU？" }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage.content).toContain('"problem_finder_teams":["DTSV_China"]');
    expect(result.toolMessage.content).toContain('"recent_days":7');
    expect(result.toolMessage.content).toContain('"created_count"');
    expect(result.contextText).toContain("Tool: resolve_business_terms");
    expect(result.contextText).toContain("Confidence: high");
  });

  it("executes query_dashboard_summary against the analytics API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        overview: { ticket_count: 12 },
        snapshot_version: "snapshot-20260707-1",
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "query_dashboard_summary",
          arguments: JSON.stringify({
            filters: {
              years: 2026,
              problem_finder_teams: "DTSV_China",
              creation_time_start: "2026-06-01",
              creation_time_end: "2026-06-30",
            },
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/full-picture/dashboard/summary?years=2026&problem_finder_teams=DTSV_China&creation_time_start=2026-06-01&creation_time_end=2026-06-30",
    );
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      name: "query_dashboard_summary",
      content: expect.stringContaining('"ticket_count":12'),
    });
    expect(result.contextText).toContain("Tool: query_dashboard_summary");
    expect(result.contextText).toContain("Result: 12 defects");
    expect(result.contextText).toContain("snapshot-20260707-1");
  });

  it("returns a tool error for unsupported tool names", async () => {
    const result = await executeMainAgentToolCall({
      id: "call-2",
      type: "function",
      function: {
        name: "run_sql",
        arguments: "{}",
      },
    });

    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-2",
      name: "run_sql",
      content: JSON.stringify({ error: "Unsupported tool: run_sql" }),
    });
    expect(result.contextText).toContain("Unsupported tool: run_sql");
  });

  it("executes query_testing_coverage_project_status against the analytics API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          project: "SP25",
          total_testcases: 100,
          passed_testcases: 82,
          failed_testcases: 6,
        },
      ]),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-3",
        type: "function",
        function: {
          name: "query_testing_coverage_project_status",
          arguments: JSON.stringify({
            filters: {
              years: ["2026"],
              projects: ["SP25"],
              aidas: ["Speech"],
            },
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/testing/coverage-analysis/project-status?years=2026&projects=SP25&aidas=Speech",
    );
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-3",
      name: "query_testing_coverage_project_status",
      content: expect.stringContaining('"project":"SP25"'),
    });
    expect(result.contextText).toContain("Tool: query_testing_coverage_project_status");
    expect(result.contextText).toContain("Rows: 1");
  });

  it("executes search_duplicates through the duplicate bridge", async () => {
    const ensureDuplicateWarmup = vi.fn().mockResolvedValue(undefined);
    const runDuplicateBridge = vi.fn().mockResolvedValue({
      success: true,
      result: {
        candidates: [
          {
            ticketId: "2687001",
            name: "Camera black screen",
            score1to10: 9,
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 2,
        dataset_size: 34717,
      },
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-4",
        type: "function",
        function: {
          name: "search_duplicates",
          arguments: JSON.stringify({ query: "camera black screen after boot", top_k: 3 }),
        },
      },
      {
        ensureDuplicateWarmup,
        runDuplicateBridge,
      },
    );

    expect(ensureDuplicateWarmup).toHaveBeenCalledTimes(1);
    expect(runDuplicateBridge).toHaveBeenCalledWith({
      action: "search",
      query: "camera black screen after boot",
      top_k: 3,
    });
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-4",
      name: "search_duplicates",
      content: expect.stringContaining('"ticketId":"2687001"'),
    });
    expect(result.contextText).toContain("Tool: search_duplicates");
    expect(result.contextText).toContain("Candidate count: 1");
    expect(result.contextText).toContain("Ticket 2687001");
  });

  it("executes query_defect_high_frequency_analysis against the analytics API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        snapshot_version: "snapshot-20260708-1",
        overview: {
          module_count: 2,
          repeat_rate: 67,
          critical_count: 1,
          total_count: 9,
        },
        frequency_rows: [
          { module: "HU-H", count: 5, severity: "High" },
          { module: "ADCAM", count: 4, severity: "Medium" },
        ],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-5",
        type: "function",
        function: {
          name: "query_defect_high_frequency_analysis",
          arguments: JSON.stringify({
            filters: {
              years: "2026",
              creation_time_start: "2026-07-02",
              creation_time_end: "2026-07-08",
            },
            limit: 5,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/full-picture/defect-high-frequency-analysis?years=2026&creation_time_start=2026-07-02&creation_time_end=2026-07-08&limit=5",
    );
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-5",
      name: "query_defect_high_frequency_analysis",
      content: expect.stringContaining('"module":"HU-H"'),
    });
    expect(result.contextText).toContain("Tool: query_defect_high_frequency_analysis");
    expect(result.contextText).toContain("Total defects: 9");
    expect(result.contextText).toContain("HU-H: 5");
  });

  it("converts recent_days to creation-time filters for defect high-frequency analysis", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        overview: { total_count: 0, module_count: 0, repeat_rate: 0, critical_count: 0 },
        frequency_rows: [],
      }),
    });

    await executeMainAgentToolCall(
      {
        id: "call-6",
        type: "function",
        function: {
          name: "query_defect_high_frequency_analysis",
          arguments: JSON.stringify({
            filters: { recent_days: 7 },
            limit: 12,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        now: new Date("2026-07-08T15:00:00Z"),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/full-picture/defect-high-frequency-analysis?creation_time_start=2026-07-02&creation_time_end=2026-07-08&years=2026&limit=12",
    );
  });

  it("executes query_full_picture_module against allowed analytics modules", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        snapshot_version: "snapshot-20260708-1",
        long_runner_rows: [{ ticket_id: "D1", age_days: 42 }],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-7",
        type: "function",
        function: {
          name: "query_full_picture_module",
          arguments: JSON.stringify({
            module: "long_runner_analysis",
            filters: { years: "2026", projects: ["SP25"] },
            limit: 8,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/full-picture/long-runner-analysis?years=2026&projects=SP25&limit=8",
    );
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-7",
      name: "query_full_picture_module",
      content: expect.stringContaining('"long_runner_rows"'),
    });
    expect(result.contextText).toContain("Tool: query_full_picture_module");
    expect(result.contextText).toContain("Module: long_runner_analysis");
    expect(result.contextText).toContain("long_runner_rows: 1 rows");
  });

  it("rejects unknown query_full_picture_module modules", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "call-8",
        type: "function",
        function: {
          name: "query_full_picture_module",
          arguments: JSON.stringify({ module: "raw_sql", filters: {} }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage.content).toBe(JSON.stringify({ error: "Unsupported full picture module: raw_sql" }));
    expect(result.contextText).toContain("Unsupported full picture module: raw_sql");
  });

  it("executes ask_clarification without calling data APIs", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "call-9",
        type: "function",
        function: {
          name: "ask_clarification",
          arguments: JSON.stringify({
            question: "要限定哪个项目或团队？",
            reason: "用户要求趋势分析，但没有给出项目/团队范围。",
            options: ["DTSV_China", "全部团队"],
          }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.requiresUserInput).toBe(true);
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-9",
      name: "ask_clarification",
      content: JSON.stringify({
        question: "要限定哪个项目或团队？",
        reason: "用户要求趋势分析，但没有给出项目/团队范围。",
        options: ["DTSV_China", "全部团队"],
      }),
    });
    expect(result.contextText).toContain("Tool: ask_clarification");
    expect(result.contextText).toContain("要限定哪个项目或团队？");
  });
});