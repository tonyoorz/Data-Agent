import { extractLatestUserQuery } from "./aiContext.mjs";
import { MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";

export const MAIN_AGENT_INTENT_PROFILES = Object.freeze({
  metric_query: {
    confidence: 0.88,
    reason: "metric/trend/rank wording matched",
    requiredSlots: ["metric", "time_window", "scope"],
    policyHints: ["semantic_first", "ask_if_scope_ambiguous"],
    toolNames: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_semantic_metrics", "query_dashboard_summary", "ask_clarification"],
  },
  coverage_query: {
    confidence: 0.88,
    reason: "testing coverage wording matched",
    requiredSlots: ["coverage_metric", "dimension", "threshold"],
    policyHints: ["use_testing_coverage_tools", "join_defect_impact_when_requested"],
    toolNames: ["resolve_business_terms", "search_analytics_filter_values", "query_testing_coverage_project_status", "query_testing_coverage_aida_status", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "ask_clarification"],
  },
  record_query: {
    confidence: 0.82,
    reason: "record/list/drilldown wording matched",
    requiredSlots: ["entity", "filters", "limit"],
    policyHints: ["semantic_records_first"],
    toolNames: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_semantic_records", "query_defect_records", "ask_clarification"],
  },
  traceability: {
    confidence: 0.86,
    reason: "traceability or lineage wording matched",
    requiredSlots: ["anchor", "lineage_scope"],
    policyHints: ["use_governed_traceability"],
    toolNames: ["query_traceability", "get_test_case_context", "ask_clarification"],
  },
  schema_discovery: {
    confidence: 0.84,
    reason: "schema/API/field wording matched",
    requiredSlots: ["business_concept"],
    policyHints: ["top_k_field_retrieval", "schema_hints_not_facts"],
    toolNames: ["get_ontology_catalog", "search_octane_fields", "ask_clarification"],
  },
  action_capability: {
    confidence: 0.9,
    reason: "write/update/delete capability wording matched",
    requiredSlots: ["target_entity", "action"],
    policyHints: ["use_action_ontology", "block_disabled_or_blocked_actions"],
    toolNames: ["get_ontology_catalog", "search_octane_fields", "ask_clarification"],
  },
  duplicate_search: {
    confidence: 0.86,
    reason: "duplicate/similar wording matched",
    requiredSlots: ["symptom_or_ticket"],
    policyHints: ["similarity_is_evidence_not_causality"],
    toolNames: ["search_duplicates", "ask_clarification"],
  },
  testcase_context: {
    confidence: 0.84,
    reason: "testcase drafting or Octane ticket anchor matched",
    requiredSlots: ["anchor"],
    policyHints: ["fetch_context_before_drafting"],
    toolNames: ["get_test_case_context", "ask_clarification"],
  },
  high_frequency: {
    confidence: 0.86,
    reason: "high-frequency or defect concentration wording matched",
    requiredSlots: ["time_window", "dimension"],
    policyHints: ["recent_week_maps_to_recent_days_7"],
    toolNames: ["resolve_business_terms", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_defect_high_frequency_analysis", "query_full_picture_module", "query_defect_records", "ask_clarification"],
  },
  business_risk_assessment: {
    confidence: 0.84,
    reason: "business risk or health assessment wording matched",
    requiredSlots: ["scope", "time_window"],
    policyHints: ["ontology_capability_first", "multi_signal_risk_assessment"],
    toolNames: ["get_ontology_catalog", "resolve_business_terms", "search_analytics_filter_values", "query_semantic_metrics", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_testing_coverage_project_status", "query_testing_coverage_aida_status", "query_defect_high_frequency_analysis", "query_full_picture_module", "ask_clarification"],
  },
  ontology_catalog: {
    confidence: 0.82,
    reason: "ontology capability wording matched",
    requiredSlots: ["capability_area"],
    policyHints: ["report_capability_state"],
    toolNames: ["get_ontology_catalog", "ask_clarification"],
  },
  dashboard_fallback: {
    confidence: 0.78,
    reason: "dashboard fallback or page-parity wording matched",
    requiredSlots: ["module", "filters"],
    policyHints: ["dashboard_fallback_only"],
    toolNames: ["get_data_catalog", "search_analytics_filter_values", "query_analytics", "diagnose_analytics_empty", "query_analytics_fallback", "query_full_picture_module", "query_defect_records", "ask_clarification"],
  },
  general: {
    confidence: 0.5,
    reason: "no compact intent matched",
    requiredSlots: [],
    policyHints: ["use_tool_policy"],
    toolNames: ["resolve_business_terms", "get_data_catalog", "ask_clarification"],
  },
});

export const MAIN_AGENT_TOOL_POLICIES = Object.freeze(
  Object.entries(MAIN_AGENT_INTENT_PROFILES).reduce((policies, [intent, profile]) => {
    for (const name of profile.toolNames) {
      const current = policies[name] || { name, allowedIntents: [] };
      current.allowedIntents.push(intent);
      policies[name] = current;
    }
    return policies;
  }, {}),
);

const PLANNING_QUERY_RE = /\b(DTSV|QGate|Octane|ticket|work_item|dashboard|ontology|capability|available|partial|unavailable|bug|defect|issue|top\s*issue|octane_defects|solution_cluster|assigned_ecu|business_module|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|growth|rising|increase|delta|duplicate|similar|write|update|delete|edit|risk|health|overview|assessment|empty\s*result|no\s*data|zero\s*rows)\b|entityType=work_item|id=\d+|本体|能力|缺陷|测试|覆盖率|多少|几个|统计|趋势|风险|健康度|当前情况|怎么看|怎么样|创建|提交|新建|解决|关闭|更新|修改|删除|写入|重复|查重|相似|模块|问题模块|上升|增长|环比|同比|根因|提票|报票|提了|数据.*(?:为空|没数据|没有数据|查不到)|为什么.*(?:为空|没数据|没有数据|查不到)|空结果/i;

function routeToolIntent(queryText) {
  if (/删除|更新|修改|写入|评论|comment|write|update|delete|edit/i.test(queryText)) return "action_capability";
  if (/重复|查重|相似|duplicate|similar/i.test(queryText)) return "duplicate_search";
  if (/traceability|追溯|链路|Requirement|TestRun/i.test(queryText)) return "traceability";
  if (/创建.*测试用例|回归测试|test\s*case|testcase|entityType=work_item|id=\d+/i.test(queryText)) return "testcase_context";
  if (/字段|API|UDF|filterable|sortable|editable|schema|field|octane_defects/i.test(queryText)) return "schema_discovery";
  if (/ontology|本体|能力|available|partial|unavailable|dry_run_only|disabled|blocked/i.test(queryText)) return "ontology_catalog";
  if (/缺陷高频|high.?frequency|缺陷.*集中|集中.*ECU/i.test(queryText)) return "high_frequency";
  if (/覆盖率|通过率|执行率|manual[-\s]?run|coverage|pass\s*rate|execution\s*rate/i.test(queryText)) return "coverage_query";
  if (/Full Picture|dashboard|Top Issue|long runner|page.?parity/i.test(queryText)) return "dashboard_fallback";
  if (/列出|明细|ticket|record|drilldown|list/i.test(queryText)) return "record_query";
  if (/\b(risk|health|overview|assessment)\b|\u98ce\u9669|\u5065\u5eb7\u5ea6|\u5f53\u524d\u60c5\u51b5|\u600e\u4e48\u770b|\u600e\u4e48\u6837/i.test(queryText)) return "business_risk_assessment";
  if (/覆盖率|通过率|执行率|manual[-\s]?run|多少|几个|统计|趋势|Top|排名|排序|低于|高于|新增|解决|关闭|增长|上升|环比|同比|提票|报票|提了|数据.*(?:为空|没数据|没有数据|查不到)|为什么.*(?:为空|没数据|没有数据|查不到)|空结果|coverage|pass\s*rate|execution\s*rate|count|metric|trend|rank|growth|delta|empty\s*result|no\s*data|zero\s*rows/i.test(queryText)) return "metric_query";
  return "general";
}

function toolName(toolCall) {
  return toolCall?.function?.name || "unknown_tool";
}

function toolsByName(allTools) {
  return new Map((Array.isArray(allTools) ? allTools : []).map((tool) => [tool.function?.name, tool]));
}

export function createMainAgentToolRegistry(allTools = MAIN_AGENT_TOOLS) {
  const toolMap = toolsByName(allTools);

  function toolNamesForIntent(intent) {
    return MAIN_AGENT_INTENT_PROFILES[intent]?.toolNames || (Array.isArray(allTools) ? allTools.map((tool) => tool.function?.name).filter(Boolean) : []);
  }

  function toolsForIntent(intent) {
    return toolNamesForIntent(intent).map((name) => toolMap.get(name)).filter(Boolean);
  }

  function routeIntent(messages) {
    const queryText = extractLatestUserQuery(messages);
    const intent = routeToolIntent(queryText);
    return { intent, queryText, ...MAIN_AGENT_INTENT_PROFILES[intent] };
  }

  function selectToolset(messages) {
    const routed = routeIntent(messages);
    const tools = toolsForIntent(routed.intent);
    const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
    return { ...routed, toolNames, tools };
  }

  function shouldPlanTools(messages) {
    const queryText = extractLatestUserQuery(messages);
    return routeToolIntent(queryText) !== "general" || PLANNING_QUERY_RE.test(queryText);
  }

  function isToolAllowed(name, selectedToolset) {
    return Array.isArray(selectedToolset?.toolNames) && selectedToolset.toolNames.includes(name);
  }

  function validateToolCall(toolCall, selectedToolset) {
    const name = toolName(toolCall);
    if (isToolAllowed(name, selectedToolset)) return { allowed: true, toolName: name };
    return {
      allowed: false,
      toolName: name,
      reason: `Tool ${name} is not allowed for intent ${selectedToolset?.intent || "unknown"}`,
    };
  }

  return {
    intentProfiles: MAIN_AGENT_INTENT_PROFILES,
    toolPolicies: MAIN_AGENT_TOOL_POLICIES,
    routeIntent,
    selectToolset,
    shouldPlanTools,
    toolNamesForIntent,
    toolsForIntent,
    isToolAllowed,
    validateToolCall,
  };
}

export function routeMainAgentIntent(messages) {
  return createMainAgentToolRegistry().routeIntent(messages);
}

export function selectMainAgentToolset(messages, allTools = MAIN_AGENT_TOOLS) {
  return createMainAgentToolRegistry(allTools).selectToolset(messages);
}

export function shouldPlanMainAgentTools(messages) {
  return createMainAgentToolRegistry().shouldPlanTools(messages);
}

export function toolNamesForIntent(intent, allTools = MAIN_AGENT_TOOLS) {
  return createMainAgentToolRegistry(allTools).toolNamesForIntent(intent);
}

export function toolsForIntent(intent, allTools = MAIN_AGENT_TOOLS) {
  return createMainAgentToolRegistry(allTools).toolsForIntent(intent);
}

export function isToolAllowed(name, selectedToolset) {
  return createMainAgentToolRegistry().isToolAllowed(name, selectedToolset);
}

export function validateToolCallAllowed(toolCall, selectedToolset) {
  return createMainAgentToolRegistry().validateToolCall(toolCall, selectedToolset);
}

export function buildBlockedToolResult(toolCall, selectedToolset, reason) {
  const name = toolName(toolCall);
  const content = JSON.stringify({ ok: false, tool: name, error: reason, intent: selectedToolset?.intent || "unknown" });
  return {
    toolMessage: {
      role: "tool",
      tool_call_id: toolCall?.id || "",
      name,
      content,
    },
    contextText: `# Main agent tool result\nTool: ${name}\nResult: blocked: ${reason}`,
  };
}

export function buildSelectedToolsetContext(selectedToolset) {
  const toolNames = (selectedToolset?.tools || []).map((tool) => tool.function?.name).filter(Boolean).join(", ");
  return `# Selected toolset\nIntent: ${selectedToolset?.intent || "general"}. Tools: ${toolNames}.`;
}