import { describe, expect, it, vi } from "vitest";

import {
  executeMainAgentToolCall,
  MAIN_AGENT_TOOLS,
} from "../../../server/mainAgentTools.mjs";

describe("main agent analytics tools", () => {
  const semanticQuery = {
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
  };

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
          name: "get_ontology_catalog",
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
          name: "get_test_case_context",
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
          name: "query_defect_aggregate",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]));
    expect(MAIN_AGENT_TOOLS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "query_defect_records",
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

  it("registers governed semantic analytics tools", () => {
    const names = MAIN_AGENT_TOOLS.map((tool) => tool.function.name);

    expect(names).toContain("query_semantic_metrics");
    expect(names).toContain("query_semantic_records");
    expect(names).toContain("query_traceability");
  });

  it("executes query_semantic_metrics through the semantic API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        sourceRevision: { revisionId: "snap-1" },
        data: [],
        summary: { metrics: { "defect.count": 2 }, rowCount: 2 },
        quality: { completeness: "complete" },
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "semantic-1",
        type: "function",
        function: {
          name: "query_semantic_metrics",
          arguments: JSON.stringify({ query: semanticQuery }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        actor: { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } },
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith("http://127.0.0.1:3003/api/semantic/query", expect.objectContaining({ method: "POST" }));
    const [, init] = analyticsFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      schemaVersion: "1.0",
      queryId: "semantic-1",
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      query: semanticQuery,
      actorScope: { actorId: "alice", scopeHash: "scope-a", workspaceIds: ["DTSV"], teamIds: ["DTSV"] },
    });
    expect(result.contextText).toContain("Tool: query_semantic_metrics");
    expect(result.contextText).toContain("defect.count: 2");
    expect(result.contextText).toContain("Completeness: complete");
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

  it("executes get_ontology_catalog against the ontology catalog API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ontology_version: "1.0",
        entity_types: [
          { id: "Defect", capability_state: "available" },
          { id: "Requirement", capability_state: "partial" },
        ],
        relationship_types: [
          { id: "COVERS_FEATURE", capability_state: "available" },
        ],
        agent_tools: [
          { id: "get_test_case_context", primitive: "context", capability_state: "available" },
        ],
        actions: [
          { id: "octane.defect.add_comment", operation: "comment", capability_state: "dry_run_only" },
          { id: "octane.defect.delete_work_item", operation: "delete", capability_state: "blocked" },
        ],
        guardrails: ["Missing data is unknown, not zero."],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "ontology-catalog-1",
        type: "function",
        function: {
          name: "get_ontology_catalog",
          arguments: "{}",
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith("http://127.0.0.1:3003/api/ontology/catalog");
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "ontology-catalog-1",
      name: "get_ontology_catalog",
      content: expect.stringContaining('"ontology_version":"1.0"'),
    });
    expect(result.contextText).toContain("Tool: get_ontology_catalog");
    expect(result.contextText).toContain("Ontology version: 1.0");
    expect(result.contextText).toContain("Entities: Defect available, Requirement partial");
    expect(result.contextText).toContain("Agent tools: get_test_case_context available");
    expect(result.contextText).toContain("Actions: octane.defect.add_comment dry_run_only, octane.defect.delete_work_item blocked");
    expect(result.contextText).toContain("Missing data is unknown");
  });

  it("executes search_octane_fields against the ontology field search API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: { fieldCount: 120, rawJsonFieldCount: 40, candidateFieldCount: 12 },
        results: [
          {
            id: "octane_defects.raw_json.problem_finder_team_udf",
            entity: "defect",
            field: "problem_finder_team_udf",
            businessBucket: "ownership",
            ontologyStatus: "mapped",
            score: 8,
          },
        ],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "field-search-1",
        type: "function",
        function: {
          name: "search_octane_fields",
          arguments: JSON.stringify({ query: "DTSV 车系", top_k: 5 }),
        },
      },
      { analyticsFetch, analyticsApiBase: "http://127.0.0.1:3003" },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/ontology/fields/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "DTSV 车系", top_k: 5 }),
      }),
    );
    expect(result.toolMessage.content).toContain("problem_finder_team_udf");
    expect(result.contextText).toContain("Tool: search_octane_fields");
    expect(result.contextText).toContain("octane_defects.raw_json.problem_finder_team_udf");
    expect(result.contextText).toContain("Use these field candidates only as schema hints");
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

  it("executes get_test_case_context against the ontology context API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        anchor: { node_id: "testcase:T-ONTO-1", node_type: "Testcase", label: "Speech wakeup regression" },
        defect_context: {
          defect_id: "D-ONTO-1",
          name: "Remote services fail after overnight bus sleep",
          description: "Sleep vehicle overnight, run remote services from My BMW app, first try failed and second try passed.",
          requirement: "Remote service requirement",
          evidence: ["defect:D-ONTO-1"],
        },
        business_scope: { project: "IDCEVO", release: "R-26-07", planned_week: "2026-CW29" },
        coverage_summary: { latest_runs: 2, passed: 1, failed: 1, requires_attention: 0, linked_defects: 1 },
        traceability: { features: [{ id: "F-ONTO-1", name: "Speech wakeup feature CW29" }], stories: [], defects: [] },
        gaps: [{ gap_type: "failed_related_run", description: "Related testcase has failed or requires-attention runs." }],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-context",
        type: "function",
        function: {
          name: "get_test_case_context",
          arguments: JSON.stringify({
            anchor: { type: "test_id", value: "T-ONTO-1" },
            purpose: "create_test_case",
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/ontology/context",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(analyticsFetch.mock.calls[0][1].body)).toEqual({
      anchor: { type: "test_id", value: "T-ONTO-1" },
      purpose: "create_test_case",
    });
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-context",
      name: "get_test_case_context",
      content: expect.stringContaining('"node_id":"testcase:T-ONTO-1"'),
    });
    expect(result.contextText).toContain("Tool: get_test_case_context");
    expect(result.contextText).toContain("Anchor: testcase:T-ONTO-1");
    expect(result.contextText).toContain("Runs: 2");
    expect(result.contextText).toContain("Defect: D-ONTO-1 Remote services fail after overnight bus sleep");
    expect(result.contextText).toContain("Sleep vehicle overnight, run remote services from My BMW app");
    expect(result.contextText).toContain("Feature: Speech wakeup feature CW29");
    expect(result.contextText).toContain("failed_related_run");
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

  it("executes query_defect_aggregate against the analytics query kernel", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        snapshot_version: "snapshot-defect-query",
        query_fingerprint: "fp-1",
        rows: [
          {
            business_module: "Navigation CN",
            defect_count: 2,
            drilldown_ref: "ref-1",
          },
        ],
        total_groups: 1,
        returned_groups: 1,
        truncated: false,
        warnings: [],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-aggregate",
        type: "function",
        function: {
          name: "query_defect_aggregate",
          arguments: JSON.stringify({
            metrics: ["defect_count"],
            dimensions: ["business_module"],
            filters: { problem_finder_teams: ["DTSV_China"] },
            time: { field: "creation_time", current: ["2026-04-01", "2026-06-30"], timezone: "Asia/Shanghai" },
            order_by: [{ field: "defect_count", direction: "desc" }],
            limit: 12,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/analytics/defects/aggregate",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(requestBody.dimensions).toEqual(["business_module"]);
    expect(requestBody.time.field).toBe("creation_time");
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-aggregate",
      name: "query_defect_aggregate",
      content: expect.stringContaining('"snapshot_version":"snapshot-defect-query"'),
    });
    expect(result.contextText).toContain("Tool: query_defect_aggregate");
    expect(result.contextText).toContain("Navigation CN: defect_count 2");
    expect(result.contextText).toContain("drilldown_ref: ref-1");
  });

  it("executes query_defect_records with a drilldown ref", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        snapshot_version: "snapshot-defect-query",
        query_fingerprint: "fp-1",
        rows: [
          {
            ticket_id: "D-001",
            ticket_name: "Navigation black screen",
            solution_cluster: "Navigation CN",
          },
        ],
        total_rows: 1,
        returned_rows: 1,
        truncated: false,
        warnings: ["records are examples"],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-records",
        type: "function",
        function: {
          name: "query_defect_records",
          arguments: JSON.stringify({ drilldown_ref: "ref-1", limit: 5 }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/analytics/defects/records",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(analyticsFetch.mock.calls[0][1].body)).toEqual({ drilldown_ref: "ref-1", limit: 5 });
    expect(result.contextText).toContain("Tool: query_defect_records");
    expect(result.contextText).toContain("D-001: Navigation black screen");
    expect(result.contextText).toContain("records are examples");
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