export const MAIN_AGENT_TOOLSET_NAMES = Object.freeze({
  chitchat: [],
  out_of_scope: [],
  clarification: [],
  metric_query: ["resolve", "analyze"],
  coverage_query: ["resolve", "analyze", "records"],
  record_query: ["resolve", "analyze", "records"],
  traceability: ["trace", "prepare_testcase"],
  schema_discovery: ["catalog"],
  action_capability: ["catalog"],
  duplicate_search: ["duplicate_search"],
  testcase_context: ["prepare_testcase"],
  high_frequency: ["resolve", "analyze", "records"],
  business_risk_assessment: ["catalog", "resolve", "analyze", "records", "trace"],
  ontology_catalog: ["catalog"],
  dashboard_fallback: ["catalog", "resolve", "analyze", "records"],
  general: ["catalog", "resolve"],
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
