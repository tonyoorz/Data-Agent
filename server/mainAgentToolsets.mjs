export const MAIN_AGENT_TOOLSET_NAMES = Object.freeze({
  chitchat: [],
  out_of_scope: [],
  clarification: [],
  metric_query: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_semantic_metrics", "query_dashboard_summary", "ask_clarification"],
  coverage_query: ["resolve_business_terms", "search_analytics_filter_values", "query_testing_coverage_project_status", "query_testing_coverage_aida_status", "query_testing_team_fv_analysis", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "ask_clarification"],
  record_query: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_semantic_records", "query_defect_records", "ask_clarification"],
  traceability: ["query_traceability", "get_test_case_context", "ask_clarification"],
  schema_discovery: ["get_ontology_catalog", "search_octane_fields", "ask_clarification"],
  action_capability: ["get_ontology_catalog", "search_octane_fields", "ask_clarification"],
  duplicate_search: ["search_duplicates", "ask_clarification"],
  testcase_context: ["get_test_case_context", "ask_clarification"],
  high_frequency: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_defect_high_frequency_analysis", "query_full_picture_module", "query_defect_records", "ask_clarification"],
  business_risk_assessment: ["get_ontology_catalog", "resolve_business_terms", "search_analytics_filter_values", "query_semantic_metrics", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_testing_coverage_project_status", "query_testing_coverage_aida_status", "query_defect_high_frequency_analysis", "query_full_picture_module", "ask_clarification"],
  ontology_catalog: ["get_ontology_catalog", "ask_clarification"],
  dashboard_fallback: ["get_data_catalog", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_full_picture_module", "query_defect_records", "ask_clarification"],
  general: ["resolve_business_terms", "get_data_catalog", "ask_clarification"],
});

export function toolNamesForIntent(intent, allTools) {
  const allNames = Array.isArray(allTools) ? allTools.map((tool) => tool.function?.name).filter(Boolean) : [];
  return MAIN_AGENT_TOOLSET_NAMES[intent] || allNames;
}

export function toolsForIntent(intent, allTools) {
  const byName = new Map((Array.isArray(allTools) ? allTools : []).map((tool) => [tool.function?.name, tool]));
  return toolNamesForIntent(intent, allTools).map((name) => byName.get(name)).filter(Boolean);
}

export function isToolAllowed(toolName, selectedToolset) {
  return Array.isArray(selectedToolset?.toolNames) && selectedToolset.toolNames.includes(toolName);
}