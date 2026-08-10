export const MAIN_AGENT_TOOL_DATA_BOUNDARIES = Object.freeze({
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

export function mainAgentToolDataBoundary(toolName) {
  return MAIN_AGENT_TOOL_DATA_BOUNDARIES[String(toolName || "")] || null;
}
