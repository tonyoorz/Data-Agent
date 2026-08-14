import { describe, expect, it } from "vitest";

import { MAIN_AGENT_TOOLS } from "../../../server/mainAgentTools.mjs";
import { MAIN_AGENT_TOOL_DATA_BOUNDARIES } from "../../../server/mainAgentToolDataBoundary.mjs";
import { MAIN_AGENT_PRIMITIVE_TOOLS } from "../../../server/mainAgentPrimitives.mjs";
import {
  createMainAgentToolRegistry,
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolRegistry.mjs";

describe("main agent tool registry", () => {
  it("classifies every registered tool at the OIDC data boundary", () => {
    const toolNames = MAIN_AGENT_TOOLS.map((tool) => tool.function.name).sort();
    expect(Object.keys(MAIN_AGENT_TOOL_DATA_BOUNDARIES).sort()).toEqual(toolNames);
    expect(MAIN_AGENT_TOOL_DATA_BOUNDARIES).toEqual({
      get_data_catalog: "metadata",
      get_ontology_catalog: "metadata",
      search_octane_fields: "metadata",
      resolve_business_terms: "metadata",
      ask_clarification: "metadata",
      query_analytics: "scoped_data",
      diagnose_analytics_empty: "scoped_data",
      query_semantic_metrics: "scoped_data",
      query_semantic_records: "scoped_data",
      query_traceability: "scoped_data",
      query_testing_team_fv_analysis: "scoped_data",
      query_defect_aggregate: "scoped_data",
      query_defect_records: "scoped_data",
      search_analytics_filter_values: "internal_only",
      query_analytics_fallback: "internal_only",
      query_dashboard_summary: "internal_only",
      query_testing_coverage_project_status: "internal_only",
      query_testing_coverage_aida_status: "internal_only",
      get_test_case_context: "internal_only",
      query_defect_high_frequency_analysis: "internal_only",
      query_full_picture_module: "internal_only",
      search_duplicates: "internal_only",
    });
  });

  it("derives compact toolsets from tool metadata", () => {
    const registry = createMainAgentToolRegistry(MAIN_AGENT_PRIMITIVE_TOOLS);
    const selected = registry.selectToolset([{ role: "user", content: "Octane defect 字段能不能更新？能不能删除缺陷单？" }]);

    expect(selected.intent).toBe("action_capability");
    expect(selected.toolNames).toEqual(["catalog"]);
    expect(selected.tools.map((tool) => tool.function.name)).toEqual(selected.toolNames);
    expect(registry.validateToolCall({ function: { name: "analyze" } }, selected)).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining("not allowed") }),
    );
  });

  it("uses one routing source for planning trigger and selected intent", () => {
    const messages = [{ role: "user", content: "DTSV 当前风险怎么看？" }];

    expect(shouldPlanMainAgentTools(messages)).toBe(true);
    expect(selectMainAgentToolset(messages).intent).toBe("business_risk_assessment");
  });

  it("routes Chinese defect ID display wording to the record-query toolset", () => {
    const messages = [{ role: "user", content: "最近7天一些严重的defect，带着id展示" }];

    expect(shouldPlanMainAgentTools(messages)).toBe(true);
    expect(selectMainAgentToolset(messages)).toMatchObject({
      intent: "record_query",
      toolNames: expect.arrayContaining(["records"]),
    });
  });

  it("routes DTSV internal testing-group comparisons to the FV analysis tool", () => {
    const selected = selectMainAgentToolset([
      { role: "user", content: "对比 DTSV_China 内部测试小组的通过率和缺陷发现率" },
    ]);

    expect(selected.intent).toBe("coverage_query");
    expect(selected.toolNames).toContain("analyze");
  });
});
