import { extractLatestUserQuery } from "./aiContext.mjs";
import { classifyDirectMainAgentIntent, DIRECT_MAIN_AGENT_INTENT_PROFILES } from "./mainAgentDirectIntent.mjs";
import { toolsForIntent } from "./mainAgentToolsets.mjs";

const INTENT_PROFILES = Object.freeze({
  chitchat: DIRECT_MAIN_AGENT_INTENT_PROFILES.chitchat,
  out_of_scope: DIRECT_MAIN_AGENT_INTENT_PROFILES.out_of_scope,
  clarification: DIRECT_MAIN_AGENT_INTENT_PROFILES.clarification,
  metric_query: {
    confidence: 0.88,
    reason: "metric/trend/rank wording matched",
    requiredSlots: ["metric", "time_window", "scope"],
    policyHints: ["semantic_first", "ask_if_scope_ambiguous"],
  },
  coverage_query: {
    confidence: 0.88,
    reason: "testing coverage wording matched",
    requiredSlots: ["coverage_metric", "dimension", "threshold"],
    policyHints: ["use_testing_coverage_tools", "join_defect_impact_when_requested"],
  },
  record_query: {
    confidence: 0.82,
    reason: "record/list/drilldown wording matched",
    requiredSlots: ["entity", "filters", "limit"],
    policyHints: ["semantic_records_first"],
  },
  traceability: {
    confidence: 0.86,
    reason: "traceability or lineage wording matched",
    requiredSlots: ["anchor", "lineage_scope"],
    policyHints: ["use_governed_traceability"],
  },
  schema_discovery: {
    confidence: 0.84,
    reason: "schema/API/field wording matched",
    requiredSlots: ["business_concept"],
    policyHints: ["top_k_field_retrieval", "schema_hints_not_facts"],
  },
  action_capability: {
    confidence: 0.9,
    reason: "write/update/delete capability wording matched",
    requiredSlots: ["target_entity", "action"],
    policyHints: ["use_action_ontology", "block_disabled_or_blocked_actions"],
  },
  duplicate_search: {
    confidence: 0.86,
    reason: "duplicate/similar wording matched",
    requiredSlots: ["symptom_or_ticket"],
    policyHints: ["similarity_is_evidence_not_causality"],
  },
  testcase_context: {
    confidence: 0.84,
    reason: "testcase drafting or Octane ticket anchor matched",
    requiredSlots: ["anchor"],
    policyHints: ["fetch_context_before_drafting"],
  },
  high_frequency: {
    confidence: 0.86,
    reason: "high-frequency or defect concentration wording matched",
    requiredSlots: ["time_window", "dimension"],
    policyHints: ["recent_week_maps_to_recent_days_7"],
  },
  business_risk_assessment: {
    confidence: 0.84,
    reason: "business risk or health assessment wording matched",
    requiredSlots: ["scope", "time_window"],
    policyHints: ["ontology_capability_first", "multi_signal_risk_assessment"],
  },
  ontology_catalog: {
    confidence: 0.82,
    reason: "ontology capability wording matched",
    requiredSlots: ["capability_area"],
    policyHints: ["report_capability_state"],
  },
  dashboard_fallback: {
    confidence: 0.78,
    reason: "dashboard fallback or page-parity wording matched",
    requiredSlots: ["module", "filters"],
    policyHints: ["dashboard_fallback_only"],
  },
  general: {
    confidence: 0.5,
    reason: "no compact intent matched",
    requiredSlots: [],
    policyHints: ["use_tool_policy"],
  },
});

function routeToolIntent(queryText) {
  if (/删除|更新|修改|写入|评论|comment|write|update|delete|edit/i.test(queryText)) return "action_capability";
  if (/重复|查重|相似|duplicate|similar/i.test(queryText)) return "duplicate_search";
  if (/traceability|追溯|追踪|链路|Requirement|TestRun/i.test(queryText)) return "traceability";
  if (/创建.*测试用例|回归测试|test\s*case|testcase|entityType=work_item|id=\d+/i.test(queryText)) return "testcase_context";
  if (/字段|API|UDF|filterable|sortable|editable|schema|field|octane_defects/i.test(queryText)) return "schema_discovery";
  if (/ontology|本体|能力|available|partial|unavailable|dry_run_only|disabled|blocked/i.test(queryText)) return "ontology_catalog";
  if (/缺陷高频|high.?frequency|缺陷.*集中|集中.*ECU/i.test(queryText)) return "high_frequency";
  if (/覆盖率|通过率|执行率|执行效率|缺陷发现率|测试小组|manual[-\s]?run|coverage|pass\s*rate|execution\s*rate/i.test(queryText)) return "coverage_query";
  if (/Full Picture|dashboard|Top Issue|long runner|page.?parity/i.test(queryText)) return "dashboard_fallback";
  if (/列出|明细|ticket|record|drilldown|list|(?:带(?:着)?|展示|显示|返回)\s*(?:缺陷\s*)?(?:id|编号|ticket\s*id)|(?:id|编号|ticket\s*id)\s*(?:展示|列表|明细)/i.test(queryText)) return "record_query";
  if (/\b(risk|health|overview|assessment)\b|风险|健康度|当前情况|怎么看|怎么样/i.test(queryText)) return "business_risk_assessment";
  if (/覆盖率|通过率|执行率|执行效率|缺陷发现率|测试小组|manual[-\s]?run|多少|几个|统计|趋势|Top|排名|排序|低于|高于|新增|解决|关闭|增长|上升|环比|同比|提票|报票|提了|数据.*(?:为空|没数据|没有数据|查不到)|为什么.*(?:为空|没数据|没有数据|查不到)|空结果|coverage|pass\s*rate|execution\s*rate|count|metric|trend|rank|growth|delta|empty\s*result|no\s*data|zero\s*rows/i.test(queryText)) return "metric_query";
  return "general";
}

export function routeMainAgentIntent(messages) {
  const queryText = extractLatestUserQuery(messages);
  const directIntent = classifyDirectMainAgentIntent(queryText);
  if (directIntent) {
    return { queryText, ...directIntent };
  }
  const intent = routeToolIntent(queryText);
  return { intent, queryText, ...INTENT_PROFILES[intent] };
}

export function selectMainAgentToolset(messages, allTools) {
  const routed = routeMainAgentIntent(messages);
  const tools = toolsForIntent(routed.intent, allTools);
  return { ...routed, toolNames: tools.map((tool) => tool.function?.name).filter(Boolean), tools };
}
