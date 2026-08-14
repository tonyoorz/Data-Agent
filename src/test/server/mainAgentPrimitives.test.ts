// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { buildToolEvidence, evaluateSemanticEvidence } from "../../../server/mainAgentEvidence.mjs";
import {
  expandPrimitiveToolCall,
  MAIN_AGENT_PRIMITIVE_NAMES,
  MAIN_AGENT_PRIMITIVE_TOOLS,
  toPrimitiveToolCall,
  wrapPrimitiveResult,
} from "../../../server/mainAgentPrimitives.mjs";
import { executeMainAgentPlannedToolCall, selectMainAgentToolset } from "../../../server/mainAgentToolPlanning.mjs";
import { executeMainAgentToolCall } from "../../../server/mainAgentTools.mjs";
import { sanitizeTestCaseHtml } from "../../../server/testCaseProposal.mjs";

describe("main agent v7 primitives", () => {
  it("exposes exactly seven model-visible primitives", () => {
    expect(MAIN_AGENT_PRIMITIVE_TOOLS.map((tool) => tool.function.name)).toEqual(MAIN_AGENT_PRIMITIVE_NAMES);
    expect(MAIN_AGENT_PRIMITIVE_NAMES).toHaveLength(7);
  });

  it("keeps legacy operations behind typed primitive branches", () => {
    const primitive = toPrimitiveToolCall({
      id: "metric-1",
      type: "function",
      function: { name: "query_semantic_metrics", arguments: '{"query":{"intent":"rank"}}' },
    });
    expect(primitive).toMatchObject({
      function: { name: "analyze" },
    });
    const expansion = expandPrimitiveToolCall(primitive!);
    expect(expansion).toMatchObject({
      primitive: "analyze",
      operation: "semantic_metrics",
      adapterTool: "query_semantic_metrics",
      adapterCall: { function: { name: "query_semantic_metrics" } },
    });
  });

  it("executes a semantic metric plan by actor-bound plan reference", () => {
    const call = {
      id: "plan-call",
      function: { name: "analyze", arguments: '{"operation":"semantic_metrics","input":{"plan_ref":"plan-1"}}' },
    };
    expect(expandPrimitiveToolCall(call, {
      governedQueryPlan: {
        planId: "plan-1",
        steps: [{ operation: "semantic_metric_query", toolName: "query_semantic_metrics", canonicalArgs: { query: { intent: "rank" } } }],
      },
    })).toMatchObject({ adapterCall: { function: { name: "query_semantic_metrics", arguments: '{"query":{"intent":"rank"}}' } } });
    expect(() => expandPrimitiveToolCall(call, { governedQueryPlan: { planId: "plan-other", steps: [] } }))
      .toThrow("PRIMITIVE_PLAN_REF_INVALID");
  });

  it("rejects operations that are not in the server registry", () => {
    expect(() => expandPrimitiveToolCall({
      id: "bad",
      function: { name: "analyze", arguments: '{"operation":"raw_sql","input":{"sql":"select 1"}}' },
    })).toThrow("PRIMITIVE_OPERATION_NOT_ALLOWED:analyze:raw_sql");
  });

  it("keeps semantic record drilldown bound to a plan or analysis reference", () => {
    const expanded = expandPrimitiveToolCall({
      id: "records-1",
      function: { name: "records", arguments: '{"operation":"semantic","input":{"plan_ref":"plan-1"}}' },
    }, {
      governedQueryPlan: {
        planId: "plan-1",
        steps: [{
          operation: "semantic_record_query",
          toolName: "query_semantic_records",
          canonicalArgs: { ontology_version: "v1", schema_fingerprint: "a".repeat(64), query: { intent: "records" }, analysis_ref: null, selections: [], fields: ["id"], page: 1, page_size: 20 },
        }],
      },
    });
    expect(JSON.parse(expanded.adapterCall.function.arguments)).toMatchObject({ query: { intent: "records" }, fields: ["id"] });
    expect(() => expandPrimitiveToolCall({
      id: "records-bad",
      function: { name: "records", arguments: '{"operation":"semantic","input":{"query":{"intent":"records"}}}' },
    })).toThrow("PRIMITIVE_INPUT_INVALID");
  });

  it("executes traceability only from a governed graph plan", () => {
    const call = { id: "trace-1", function: { name: "trace", arguments: '{"plan_ref":"plan-trace"}' } };
    const expansion = expandPrimitiveToolCall(call, {
      governedQueryPlan: {
        planId: "plan-trace",
        steps: [{ operation: "traceability_query", toolName: "query_traceability", canonicalArgs: { query: { intent: "trace" } } }],
      },
    });
    expect(expansion.adapterCall).toMatchObject({ function: { name: "query_traceability", arguments: '{"query":{"intent":"trace"}}' } });
    expect(() => expandPrimitiveToolCall({ id: "bad-trace", function: { name: "trace", arguments: '{"query":{"intent":"trace"}}' } }))
      .toThrow("PRIMITIVE_INPUT_INVALID:trace:direct");
  });

  it("authorizes the public primitive and executes only its private adapter", async () => {
    const selectedToolset = selectMainAgentToolset([{ role: "user", content: "最近一周缺陷 Top 5" }]);
    const executeAdapter = vi.fn().mockResolvedValue({
      toolMessage: { role: "tool", tool_call_id: "a1", name: "query_analytics", content: '{"ok":true,"tool":"query_analytics","url":"http://analytics/aggregate","result":{"rows":[{"business_module":"Camera","defect_count":3}]}}' },
      contextText: "aggregate rows",
    });
    const result = await executeMainAgentPlannedToolCall({
      selectedToolset,
      executeToolCall: executeAdapter,
      toolCall: {
        id: "a1",
        type: "function",
        function: {
          name: "analyze",
          arguments: JSON.stringify({
            operation: "defect_aggregate",
            input: {
              dataset: "defects", intent: "rank", metrics: ["defect_count"], dimensions: ["business_module"], filters: {},
              time: { field: "creation_time", current: ["2026-08-06", "2026-08-13"], timezone: "Asia/Shanghai" },
            },
          }),
        },
      },
    });
    expect(executeAdapter).toHaveBeenCalledWith(expect.objectContaining({ function: expect.objectContaining({ name: "query_analytics" }) }), expect.any(Object));
    expect(result.result.toolMessage.name).toBe("analyze");
    expect(result.evidence).toMatchObject({ evidenceKind: "metric_result", adapterTool: "query_analytics" });
    expect(evaluateSemanticEvidence([result.evidence]).status).toBe("pass");
  });

  it("preserves primitive provenance when wrapping adapter output", () => {
    const call = { id: "d1", function: { name: "duplicate_search", arguments: '{"query":"black screen"}' } };
    const expansion = expandPrimitiveToolCall(call);
    const wrapped = wrapPrimitiveResult(call, expansion, {
      toolMessage: { role: "tool", tool_call_id: "d1", name: "search_duplicates", content: '{"ok":true,"tool":"search_duplicates","result":{"candidates":[{"ticketId":"1"}]}}' },
      contextText: "candidate 1",
    });
    const evidence = buildToolEvidence({ toolCall: call, result: wrapped, intent: "duplicate_search" });
    expect(evidence).toMatchObject({
      tool: "duplicate_search",
      adapterTool: "search_duplicates",
      evidenceKind: "similarity_candidates",
      data: [{ ticketId: "1" }],
    });
  });

  it("prepares a verified, sanitized, digest-bound testcase proposal without committing", async () => {
    const bridge = vi.fn(async (input) => input.action === "prepare"
      ? { success: true, defect_info: { defect_id: "42", name: "Black screen", project: "P1" }, few_shot_text: "example", similar_cases: [] }
      : { success: true, verification: { passed: true, criteria: ["checkpoint"] } });
    const result = await executeMainAgentToolCall({
      id: "tc-1",
      function: { name: "prepare_testcase", arguments: '{"anchor":{"type":"defect_id","value":"42"},"purpose":"create_test_case"}' },
    }, {
      runTestCaseBridge: bridge,
      generateTestCaseProposalContent: async () => ({
        testName: "Regression D42",
        descriptionHtml: '<h2 onclick="steal()">Objective</h2><script>steal()</script><p>Safe</p>',
        stepsText: "- action\n- ? output = 1",
      }),
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const payload = JSON.parse(result.toolMessage.content);
    expect(payload.result).toMatchObject({ proposalOnly: true, committed: false, generatedAt: "2026-08-13T00:00:00.000Z" });
    expect(payload.result.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.result.descriptionHtml).toBe("<h2>Objective</h2><p>Safe</p>");
    expect(bridge.mock.calls.map(([input]) => input.action)).toEqual(["prepare", "verify"]);
    const evidence = buildToolEvidence({ toolCall: { id: "tc-1", function: { name: "prepare_testcase" } }, result, intent: "testcase" });
    expect(evaluateSemanticEvidence([evidence])).toMatchObject({ status: "pass" });
  });

  it("removes active HTML content and all tag attributes", () => {
    expect(sanitizeTestCaseHtml('<img src=x onerror=bad><table class="x"><tr><td style="x">OK</td></tr></table>'))
      .toBe("<table><tr><td>OK</td></tr></table>");
  });
});
