import { describe, expect, it, vi } from "vitest";

import {
  ACTOR_CAPABILITY_HEADER,
  verifyActorCapabilityHeader,
} from "../../../server/agentActorCapability.mjs";
import {
  executeMainAgentToolCall,
  MAIN_AGENT_TOOLS,
} from "../../../server/mainAgentTools.mjs";
import { MAIN_AGENT_TOOL_DATA_BOUNDARIES } from "../../../server/mainAgentToolDataBoundary.mjs";

const AGENT_CAPABILITY_SECRET = "main-agent-tool-capability-secret";
const AGENT_CAPABILITY_NOW = 1_700_000_000;
const AGENT_ACTOR = Object.freeze({
  actorId: "alice",
  scopeHash: "scope-alice-dtsv",
  scopes: {
    allowedObjectTypes: ["quality.defect"],
    teamIds: ["DTSV_China"],
    projectIds: ["IDCEVO"],
  },
});

function scopedAgentDependencies() {
  return {
    actor: AGENT_ACTOR,
    actorCapabilitySecret: AGENT_CAPABILITY_SECRET,
    actorCapabilityNow: AGENT_CAPABILITY_NOW,
    actorCapabilityNonce: "main-agent-tool-capability-nonce",
  };
}

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
          name: "query_testing_coverage_aida_status",
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

    const recordsTool = MAIN_AGENT_TOOLS.find((tool) => tool.function.name === "query_semantic_records");
    expect(recordsTool?.function.parameters).toMatchObject({
      required: ["ontology_version", "schema_fingerprint", "query", "analysis_ref", "selections", "fields", "page", "page_size"],
      additionalProperties: false,
      properties: {
        analysis_ref: expect.any(Object),
        selections: expect.any(Object),
        fields: expect.any(Object),
        page: expect.any(Object),
        page_size: expect.any(Object),
      },
    });
  });

  it("registers high-level analytics orchestration tools", () => {
    const names = MAIN_AGENT_TOOLS.map((tool) => tool.function.name);

    expect(names).toContain("query_analytics");
    expect(names).toContain("diagnose_analytics_empty");
    expect(names).toContain("query_analytics_fallback");
  });

  it("executes query_analytics_fallback through the governed fallback API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        dataset: "defects",
        source_table: "octane_defects",
        query_fingerprint: "fallback-fp-1",
        columns: ["assigned_ecu", "defect_count"],
        rows: [{ assigned_ecu: "ECU-A", defect_count: 2 }],
        returned_rows: 1,
        truncated: false,
        audit: { readonly: true, allowlisted: true },
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-fallback",
        type: "function",
        function: {
          name: "query_analytics_fallback",
          arguments: JSON.stringify({
            dataset: "defects",
            metrics: [{ op: "count", field: "defect_id", as: "defect_count" }],
            group_by: ["assigned_ecu"],
            filters: { problem_finder_team: ["DTSV_China"] },
            time: { field: "creation_time", current: ["2026-05-01", "2026-05-31"], timezone: "Asia/Shanghai" },
            order_by: [{ field: "defect_count", direction: "desc" }],
            limit: 10,
            reason: "specialized analytics result was empty",
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/analytics/fallback/query",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(requestBody.dataset).toBe("defects");
    expect(requestBody.group_by).toEqual(["assigned_ecu"]);
    expect(result.toolMessage.name).toBe("query_analytics_fallback");
    expect(result.toolMessage.content).toContain('"readonly":true');
    expect(result.contextText).toContain("Tool: query_analytics_fallback");
    expect(result.contextText).toContain("Source table: octane_defects");
    expect(result.contextText).toContain("ECU-A: defect_count 2");
    expect(result.contextText).toContain("allowlisted read-only fallback");
  });

  it("fails closed for legacy fallback and duplicate search under an OIDC-scoped actor", async () => {
    const oidcActor = {
      actorId: "oidc-reader",
      scopeHash: "oidc-0123456789abcdef",
      scopes: { allowedObjectTypes: ["quality.defect"], teamIds: ["DTSV_China"] },
    };
    const analyticsFetch = vi.fn();
    const runDuplicateBridge = vi.fn();
    const fallback = await executeMainAgentToolCall(
      {
        id: "oidc-fallback",
        type: "function",
        function: { name: "query_analytics_fallback", arguments: JSON.stringify({ dataset: "defects" }) },
      },
      { analyticsFetch, analyticsApiBase: "http://127.0.0.1:3003", actor: oidcActor },
    );
    const duplicate = await executeMainAgentToolCall(
      {
        id: "oidc-duplicate",
        type: "function",
        function: { name: "search_duplicates", arguments: JSON.stringify({ query: "camera black screen" }) },
      },
      { runDuplicateBridge, actor: oidcActor },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(runDuplicateBridge).not.toHaveBeenCalled();
    expect(JSON.parse(fallback.toolMessage.content)).toMatchObject({ ok: false, failure: { code: "OIDC_INTERNAL_ONLY_TOOL_DENIED" } });
    expect(JSON.parse(duplicate.toolMessage.content)).toMatchObject({ ok: false, failure: { code: "OIDC_INTERNAL_ONLY_TOOL_DENIED" } });
  });

  it("fails closed for every internal-only tool under an OIDC-scoped actor", async () => {
    const oidcActor = {
      actorId: "oidc-reader",
      scopeHash: "oidc-0123456789abcdef",
      scopes: { allowedObjectTypes: ["quality.defect"], teamIds: ["DTSV_China"] },
    };
    const analyticsFetch = vi.fn();
    const runDuplicateBridge = vi.fn();
    const internalOnlyTools = Object.entries(MAIN_AGENT_TOOL_DATA_BOUNDARIES)
      .filter(([, boundary]) => boundary === "internal_only")
      .map(([name]) => name);

    for (const name of internalOnlyTools) {
      const result = await executeMainAgentToolCall(
        { id: `oidc-${name}`, type: "function", function: { name, arguments: "{}" } },
        { analyticsFetch, runDuplicateBridge, analyticsApiBase: "http://127.0.0.1:3003", actor: oidcActor },
      );
      expect(JSON.parse(result.toolMessage.content), name).toMatchObject({
        ok: false,
        failure: { code: "OIDC_INTERNAL_ONLY_TOOL_DENIED", dataBoundary: "internal_only" },
      });
    }
    const unclassified = await executeMainAgentToolCall(
      { id: "oidc-unclassified", type: "function", function: { name: "new_unclassified_tool", arguments: "{}" } },
      { analyticsFetch, analyticsApiBase: "http://127.0.0.1:3003", actor: oidcActor },
    );
    expect(JSON.parse(unclassified.toolMessage.content)).toMatchObject({
      ok: false,
      failure: { code: "OIDC_TOOL_DATA_BOUNDARY_UNCLASSIFIED" },
    });

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(runDuplicateBridge).not.toHaveBeenCalled();
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
        quality: { completeness: "complete", warnings: ["SOURCE_STALE:analytics.full_picture_defects"] },
        businessRules: { applied: ["BUSINESS_RULE_DERIVE:business.test.project_scope"] },
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
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith("http://127.0.0.1:3003/api/semantic/query", expect.objectContaining({ method: "POST" }));
    const [, init] = analyticsFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      schemaVersion: "1.0",
      queryId: "semantic-1",
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      query: semanticQuery,
    });
    expect(verifyActorCapabilityHeader(init.headers, {
      secret: AGENT_CAPABILITY_SECRET,
      now: AGENT_CAPABILITY_NOW,
    })).toMatchObject({ actorId: "alice", scopeHash: "scope-alice-dtsv" });
    expect(result.contextText).toContain("Tool: query_semantic_metrics");
    expect(result.contextText).toContain("defect.count: 2");
    expect(result.contextText).toContain("Completeness: complete");
    expect(result.contextText).toContain("Warnings: SOURCE_STALE:analytics.full_picture_defects");
    expect(result.contextText).toContain("Business rules: BUSINESS_RULE_DERIVE:business.test.project_scope");
  });

  it("executes query_semantic_records through the dedicated records API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        analysisRef: "analysis-1",
        sourceRevision: { revisionId: "snap-1", status: "pinned" },
        scope: { actorScopeHash: "scope-a", entityId: "quality.defect" },
        data: [{ defect_id: "D-1", name: "Audio issue", assigned_ecu: "HU", status: "Open" }],
        pagination: { page: 1, pageSize: 20, totalRows: 1, totalPages: 1 },
        quality: { completeness: "complete", truncated: false, warnings: [] },
        evidence: {
          kind: "semantic_record_set",
          analysisRef: "analysis-1",
          sourceRevisionId: "snap-1",
          rowCount: 1,
          totalRows: 1,
          fieldIds: ["defect_id", "name", "assigned_ecu", "status"],
        },
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "semantic-records-1",
        type: "function",
        function: {
          name: "query_semantic_records",
          arguments: JSON.stringify({
            ontology_version: "v1",
            schema_fingerprint: "a".repeat(64),
            query: null,
            analysis_ref: "analysis-1",
            selections: [{ dimensionId: "product.ecu", operator: "in", values: ["HU"] }],
            fields: ["defect_id", "name", "assigned_ecu", "status"],
            page: 1,
            page_size: 20,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith("http://127.0.0.1:3003/api/semantic/records", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      schemaVersion: "1.0",
      queryId: "semantic-records-1",
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      query: null,
      analysisRef: "analysis-1",
      selections: [{ dimensionId: "product.ecu", operator: "in", values: ["HU"] }],
      fields: ["defect_id", "name", "assigned_ecu", "status"],
      page: 1,
      pageSize: 20,
    });
    expect(verifyActorCapabilityHeader(analyticsFetch.mock.calls[0][1].headers, {
      secret: AGENT_CAPABILITY_SECRET,
      now: AGENT_CAPABILITY_NOW,
    })).toMatchObject({ actorId: "alice", scopeHash: "scope-alice-dtsv" });
    expect(result.contextText).toContain("Analysis ref: analysis-1");
    expect(result.contextText).toContain("Revision status: pinned");
    expect(result.contextText).toContain('"defect_id":"D-1"');
    expect(result.contextText).toContain("Evidence: semantic_record_set");
  });

  it("renders governed lineage metadata for traceability tool results", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ontologyVersion: "v1",
        schemaFingerprint: "a".repeat(64),
        sourceRevision: { revisionId: "trace-snap-1", status: "pinned" },
        data: [{ run_id: "MR-1" }],
        summary: { rowCount: 1 },
        quality: { completeness: "complete" },
        lineage: {
          path: [{
            id: "testing.test_run.executes.test_case",
            sourceEntity: "testing.test_run",
            targetEntity: "testing.test_case",
            cardinality: "many_to_one",
          }],
          evidence: { rowCount: 1, relationshipIds: ["testing.test_run.executes.test_case"] },
        },
      }),
    });
    const traceQuery = {
      ...semanticQuery,
      intent: "trace",
      entityIds: ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
      metricIds: [],
    };

    const result = await executeMainAgentToolCall(
      {
        id: "semantic-trace-1",
        type: "function",
        function: { name: "query_traceability", arguments: JSON.stringify({ query: traceQuery }) },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
        actor: { actorId: "alice", scopeHash: "scope-a", scopes: { allowedObjectTypes: ["testing.test_run"] } },
      },
    );

    expect(result.contextText).toContain("Lineage path: testing.test_run.executes.test_case (testing.test_run -> testing.test_case; many_to_one)");
    expect(result.contextText).toContain("Lineage evidence: 1 rows; relationships testing.test_run.executes.test_case");
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

  it("executes search_analytics_filter_values against the analytics value search API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        dataset: "defects",
        field: "detected_by",
        query: "siz",
        snapshot_version: "snapshot-values",
        values: [{ value: "Size Li", count: 2 }],
        total_values: 1,
        returned_values: 1,
        truncated: false,
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "filter-values-1",
        type: "function",
        function: {
          name: "search_analytics_filter_values",
          arguments: JSON.stringify({ dataset: "defects", field: "detected_by", query: "siz", limit: 5 }),
        },
      },
      { analyticsFetch, analyticsApiBase: "http://127.0.0.1:3003" },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/analytics/filter-values/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dataset: "defects", field: "detected_by", query: "siz", limit: 5 }),
      }),
    );
    expect(result.toolMessage.name).toBe("search_analytics_filter_values");
    expect(result.contextText).toContain("Tool: search_analytics_filter_values");
    expect(result.contextText).toContain("detected_by candidates for siz");
    expect(result.contextText).toContain("Size Li: 2");
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
    expect(result.toolMessage.content).toContain('"defect_count"');
    expect(result.toolMessage.content).not.toContain('"created_count"');
    expect(result.contextText).toContain("Tool: resolve_business_terms");
    expect(result.contextText).toContain("Confidence: high");
  });

  it("normalizes tester names in defect ticket questions to detected_by", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "terms-person",
        type: "function",
        function: {
          name: "resolve_business_terms",
          arguments: JSON.stringify({ query: "tester Size Li DTSV 今年提票情况" }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage.content).toContain('"problem_finder_teams":["DTSV_China"]');
    expect(result.toolMessage.content).toContain('"detected_by":["Size Li"]');
    expect(result.toolMessage.content).toContain('"defect_count"');
    expect(result.toolMessage.content).not.toContain('"created_count"');
    expect(result.contextText).toContain("Confidence: high");
  });

  it("normalizes plain person ticket questions to detected_by", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "terms-person-plain",
        type: "function",
        function: {
          name: "resolve_business_terms",
          arguments: JSON.stringify({ query: "2026年 size li 提了多少ticket" }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage.content).toContain('"detected_by":["Size Li"]');
    expect(result.toolMessage.content).toContain('"defect_count"');
    expect(result.contextText).toContain("Datasets: defects");
  });

  it("allows detected_by as a defect aggregate dimension", () => {
    const queryAnalyticsTool = MAIN_AGENT_TOOLS.find((tool) => tool.function.name === "query_analytics");
    const dimensionEnum = queryAnalyticsTool?.function.parameters.properties.dimensions.items.enum;

    expect(dimensionEnum).toContain("detected_by");
  });

  it("normalizes manual-run coverage clarification to the testing coverage dataset", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "terms-coverage",
        type: "function",
        function: {
          name: "resolve_business_terms",
          arguments: JSON.stringify({ query: "测试执行覆盖率 manual-run 通过率 执行率 模块 ECU" }),
        },
      },
      { analyticsFetch },
    );

    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(result.toolMessage.content).toContain('"datasets":["testing_coverage"]');
    expect(result.toolMessage.content).toContain('"coverage_rate"');
    expect(result.toolMessage.content).not.toContain('"datasets":["defects"');
    expect(result.contextText).toContain("Datasets: testing_coverage");
  });

  it("normalizes DTSV internal test groups to FV coverage analysis", async () => {
    const analyticsFetch = vi.fn();

    const result = await executeMainAgentToolCall(
      {
        id: "terms-dtsv-fv-groups",
        type: "function",
        function: {
          name: "resolve_business_terms",
          arguments: JSON.stringify({ query: "对比 DTSV_China 内部测试小组的通过率和缺陷发现率" }),
        },
      },
      { analyticsFetch },
    );

    const payload = JSON.parse(result.toolMessage.content).result;
    expect(analyticsFetch).not.toHaveBeenCalled();
    expect(payload.datasets).toEqual(["testing_coverage"]);
    expect(payload.filters).toEqual({});
    expect(payload.metrics).toEqual(expect.arrayContaining(["pass_rate", "defect_discovery_rate"]));
    expect(payload.resolved_terms).toContainEqual({
      term: "DTSV",
      mapsTo: "testing team scope with fv groups",
      value: "DTSV_China",
    });
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

  it("executes FV team analysis with a normalized coverage week", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        team: "DTSV_China",
        group_by: "fv",
        test_weeks: ["2026-CW19"],
        rows: [
          {
            fv: "Speech",
            total_runs: 10,
            passed_runs: 8,
            linked_defects: 2,
            pass_rate: 80,
            defect_discovery_rate: 20,
          },
        ],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "team-fv-analysis",
        type: "function",
        function: {
          name: "query_testing_team_fv_analysis",
          arguments: JSON.stringify({
            team: "DTSV_China",
            test_weeks: ["2026-W19"],
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/agent/analytics/testing/team-fv-analysis",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(analyticsFetch.mock.calls[0][1].body)).toEqual({
      team: "DTSV_China",
      test_weeks: ["2026-CW19"],
    });
    expect(verifyActorCapabilityHeader(analyticsFetch.mock.calls[0][1].headers, {
      secret: AGENT_CAPABILITY_SECRET,
      now: AGENT_CAPABILITY_NOW,
    })).toMatchObject({
      actorId: "alice",
      scopeHash: "scope-alice-dtsv",
      scopes: { teamIds: ["DTSV_China"] },
    });
    expect(analyticsFetch.mock.calls[0][1].headers).toHaveProperty(ACTOR_CAPABILITY_HEADER);
    expect(result.toolMessage.name).toBe("query_testing_team_fv_analysis");
    expect(result.contextText).toContain("Group dimension: fv");
    expect(result.contextText).toContain("Rows: 1");
  });

  it("executes query_testing_coverage_aida_status against the analytics API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          test_week: "2026-CW30",
          top_aida: "Speech",
          status: "Passed",
          count: 68,
        },
        {
          test_week: "2026-CW30",
          top_aida: "Speech",
          status: "Failed",
          count: 32,
        },
      ]),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-aida-coverage",
        type: "function",
        function: {
          name: "query_testing_coverage_aida_status",
          arguments: JSON.stringify({
            filters: {
              years: ["2026"],
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
      "http://127.0.0.1:3003/api/testing/coverage-analysis/aida-status?years=2026&aidas=Speech",
    );
    expect(result.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-aida-coverage",
      name: "query_testing_coverage_aida_status",
      content: expect.stringContaining('"top_aida":"Speech"'),
    });
    expect(result.contextText).toContain("Tool: query_testing_coverage_aida_status");
    expect(result.contextText).toContain("Rows: 2");
    expect(result.contextText).toContain("compute pass rate");
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
    expect(result.contextText).toContain("Constraint: similarity.not_population_statistic");
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
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(requestBody.dimensions).toEqual(["business_module"]);
    expect(requestBody.time.field).toBe("creation_time");
    expect(verifyActorCapabilityHeader(analyticsFetch.mock.calls[0][1].headers, {
      secret: AGENT_CAPABILITY_SECRET,
      now: AGENT_CAPABILITY_NOW,
    })).toMatchObject({
      actorId: "alice",
      scopeHash: "scope-alice-dtsv",
      scopes: { teamIds: ["DTSV_China"], projectIds: ["IDCEVO"] },
    });
    expect(analyticsFetch.mock.calls[0][1].headers).toHaveProperty(ACTOR_CAPABILITY_HEADER);
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

  it("executes query_analytics as the high-level defect aggregate tool", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        snapshot_version: "snapshot-query-analytics",
        query_fingerprint: "fp-query-analytics",
        rows: [{ scope: "all_defects", defect_count: 2, drilldown_ref: "ref-query" }],
        total_groups: 1,
        returned_groups: 1,
        truncated: false,
        warnings: [],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-query-analytics",
        type: "function",
        function: {
          name: "query_analytics",
          arguments: JSON.stringify({
            dataset: "defects",
            intent: "aggregate",
            metrics: ["defect_count"],
            dimensions: [],
            filters: { years: ["2026"], problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] },
            time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
            limit: 12,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      metrics: ["defect_count"],
      dimensions: [],
      filters: { years: ["2026"], problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] },
      time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
      limit: 12,
    });
    expect(result.toolMessage.name).toBe("query_analytics");
    expect(result.toolMessage.content).toContain('"tool":"query_analytics"');
    expect(result.contextText).toContain("Tool: query_analytics");
    expect(result.contextText).toContain("all_defects: defect_count 2");
  });

  it("includes derived comparison metrics in query_analytics context", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        snapshot_version: "snapshot-query-analytics-comparison",
        query_fingerprint: "fp-query-analytics-comparison",
        applied_query: {
          metrics: ["defect_count"],
          dimensions: ["business_module"],
          derived_metrics: ["delta", "growth_pct"],
        },
        rows: [
          {
            business_module: "Navigation CN",
            defect_count: 201,
            current_count: 201,
            previous_count: 35,
            delta: 166,
            growth_pct: 474.29,
            is_new: false,
            drilldown_ref: "ref-navigation",
          },
          {
            business_module: "New Module",
            defect_count: 20,
            current_count: 20,
            previous_count: 0,
            delta: 20,
            growth_pct: null,
            is_new: true,
            drilldown_ref: "ref-new-module",
          },
        ],
        total_groups: 2,
        returned_groups: 2,
        truncated: false,
        warnings: [],
      }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-query-analytics-comparison",
        type: "function",
        function: {
          name: "query_analytics",
          arguments: JSON.stringify({
            dataset: "defects",
            intent: "rank",
            metrics: ["defect_count"],
            dimensions: ["business_module"],
            derived_metrics: ["delta", "growth_pct"],
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
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(result.contextText).toContain("Navigation CN: defect_count 201, current_count 201, previous_count 35, delta 166, growth_pct 474.29%");
    expect(result.contextText).toContain("New Module: defect_count 20, current_count 20, previous_count 0, delta 20, growth_pct new_group, is_new true");
  });

  it("preserves a sanitized schema failure for bounded catalog recovery", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: "AGENT_ANALYTICS_SCHEMA_INVALID", safeMessage: "agent analytics request rejected" }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-schema-failure",
        type: "function",
        function: {
          name: "query_analytics",
          arguments: JSON.stringify({
            dataset: "defects",
            intent: "aggregate",
            metrics: ["defect_count"],
            dimensions: [],
            filters: { years: ["2026"] },
            time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(JSON.parse(result.toolMessage.content)).toEqual(expect.objectContaining({
      ok: false,
      failure: expect.objectContaining({ code: "AGENT_ANALYTICS_SCHEMA_INVALID", statusCode: 400 }),
    }));
    expect(result.contextText).not.toContain("UNSUPPORTED_DEFECT_FILTER");
  });

  it("preserves the same safe schema code from a 422-shaped agent envelope", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ code: "AGENT_ANALYTICS_SCHEMA_INVALID", safeMessage: "agent analytics request rejected" }),
    });

    const result = await executeMainAgentToolCall(
      {
        id: "call-schema-failure-422",
        type: "function",
        function: {
          name: "query_analytics",
          arguments: JSON.stringify({ dataset: "defects", intent: "aggregate", metrics: ["defect_count"], dimensions: [], filters: {} }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(JSON.parse(result.toolMessage.content)).toEqual(expect.objectContaining({
      failure: expect.objectContaining({ code: "AGENT_ANALYTICS_SCHEMA_INVALID", statusCode: 422 }),
    }));
  });

  it("diagnoses empty analytics results by relaxing defect filters", async () => {
    const aggregatePayload = (defectCount) => ({
      schema_version: "1.0",
      snapshot_version: "snapshot-empty-diagnosis",
      query_fingerprint: `fp-${defectCount}`,
      rows: [{ scope: "all_defects", defect_count: defectCount, drilldown_ref: `ref-${defectCount}` }],
      total_groups: defectCount > 0 ? 1 : 0,
      returned_groups: defectCount > 0 ? 1 : 0,
      truncated: false,
      warnings: [],
    });
    const analyticsFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(0) })
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(0) })
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(5) });

    const result = await executeMainAgentToolCall(
      {
        id: "call-empty-diagnosis",
        type: "function",
        function: {
          name: "diagnose_analytics_empty",
          arguments: JSON.stringify({
            query: {
              dataset: "defects",
              intent: "aggregate",
              metrics: ["defect_count"],
              dimensions: [],
              filters: { years: ["2026"], problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] },
              time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
              limit: 12,
            },
            reason: "query_analytics returned no aggregate rows",
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledTimes(3);
    expect(analyticsFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
    ]);
    const probeBodies = analyticsFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(probeBodies[0].filters).toEqual({ years: ["2026"], problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] });
    expect(probeBodies[1].filters).toEqual({ years: ["2026"], detected_by: ["Size Li"] });
    expect(probeBodies[2].filters).toEqual({ years: ["2026"], problem_finder_teams: ["DTSV_China"] });
    expect(result.toolMessage.name).toBe("diagnose_analytics_empty");
    const payload = JSON.parse(result.toolMessage.content).result;
    expect(payload).toEqual(expect.objectContaining({
      causeCode: "FILTER_TOO_RESTRICTIVE",
      retryQuery: expect.objectContaining({ filters: { years: ["2026"], problem_finder_teams: ["DTSV_China"] } }),
      candidateValues: [],
      recommendedClarification: "Verify the exact detected_by value or choose from available values.",
      recommendation: expect.stringContaining("detected_by"),
    }));
    expect(result.contextText).toContain("Tool: diagnose_analytics_empty");
    expect(result.contextText).toContain("Cause: FILTER_TOO_RESTRICTIVE");
    expect(result.contextText).toContain("without detected_by: defect_count 5");
    expect(result.contextText).toContain("detected_by may be too restrictive");
  });

  it("diagnoses reversed detected_by name order when a person aggregate is empty", async () => {
    const aggregatePayload = (defectCount) => ({
      schema_version: "1.0",
      snapshot_version: "snapshot-person-alias",
      query_fingerprint: `fp-alias-${defectCount}`,
      rows: [{ scope: "all_defects", defect_count: defectCount, drilldown_ref: `ref-alias-${defectCount}` }],
      total_groups: 1,
      returned_groups: 1,
      truncated: false,
      warnings: [],
    });
    const analyticsFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(0) })
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(41) })
      .mockResolvedValueOnce({ ok: true, json: async () => aggregatePayload(41) });

    const result = await executeMainAgentToolCall(
      {
        id: "call-person-alias-diagnosis",
        type: "function",
        function: {
          name: "diagnose_analytics_empty",
          arguments: JSON.stringify({
            query: {
              dataset: "defects",
              intent: "aggregate",
              metrics: ["defect_count"],
              dimensions: [],
              filters: { years: ["2026"], detected_by: ["Xu Miao"] },
              time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
              limit: 12,
            },
            reason: "query_analytics returned zero defect_count",
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
      "http://127.0.0.1:3003/api/agent/analytics/defects/aggregate",
    ]);
    const probeBodies = analyticsFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(probeBodies[0].filters).toEqual({ years: ["2026"], detected_by: ["Xu Miao"] });
    expect(probeBodies[1].filters).toEqual({ years: ["2026"], detected_by: ["Miao Xu"] });
    const payload = JSON.parse(result.toolMessage.content).result;
    expect(payload).toEqual(expect.objectContaining({
      causeCode: "FILTER_VALUE_ALIAS",
      retryQuery: expect.objectContaining({ filters: { years: ["2026"], detected_by: ["Miao Xu"] } }),
      candidateValues: [{ field: "detected_by", value: "Miao Xu", count: 41 }],
      recommendedClarification: "Use detected_by=Miao Xu if that is the intended person.",
    }));
    expect(result.contextText).toContain("detected_by alias Miao Xu: defect_count 41");
    expect(result.contextText).toContain("Cause: FILTER_VALUE_ALIAS");
    expect(result.contextText).toContain("Try detected_by=Miao Xu");
  });

  it("exposes detected_by as a person-level defect aggregate filter", async () => {
    const aggregateTool = MAIN_AGENT_TOOLS.find((tool) => tool.function.name === "query_defect_aggregate");
    const filterProperties = aggregateTool.function.parameters.properties.filters.properties;
    expect(filterProperties.detected_by).toEqual(expect.any(Object));
    expect(filterProperties.business_module).toEqual(expect.any(Object));

    const queryAnalyticsTool = MAIN_AGENT_TOOLS.find((tool) => tool.function.name === "query_analytics");
    const queryFilterProperties = queryAnalyticsTool.function.parameters.properties.filters.properties;
    expect(queryFilterProperties.business_module).toEqual(expect.any(Object));

    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: "1.0",
        snapshot_version: "snapshot-defect-query",
        query_fingerprint: "fp-person",
        rows: [{ defect_count: 1, drilldown_ref: "ref-person" }],
        total_groups: 1,
        returned_groups: 1,
        truncated: false,
        warnings: [],
      }),
    });

    await executeMainAgentToolCall(
      {
        id: "call-person-filter",
        type: "function",
        function: {
          name: "query_defect_aggregate",
          arguments: JSON.stringify({
            metrics: ["defect_count"],
            dimensions: [],
            filters: { problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] },
            time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
            limit: 12,
          }),
        },
      },
      {
        analyticsFetch,
        analyticsApiBase: "http://127.0.0.1:3003",
        ...scopedAgentDependencies(),
      },
    );

    const requestBody = JSON.parse(analyticsFetch.mock.calls[0][1].body);
    expect(requestBody.filters).toEqual({ problem_finder_teams: ["DTSV_China"], detected_by: ["Size Li"] });
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
        ...scopedAgentDependencies(),
      },
    );

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/agent/analytics/defects/records",
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
