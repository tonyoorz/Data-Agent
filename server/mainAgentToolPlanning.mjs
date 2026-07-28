import { MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";
import {
  buildSelectedToolsetContext,
  selectMainAgentToolset as selectToolsetWithTools,
  shouldPlanMainAgentTools,
} from "./mainAgentToolRegistry.mjs";

export function selectMainAgentToolset(messages) {
  return selectToolsetWithTools(messages, MAIN_AGENT_TOOLS);
}

const TOOL_PLANNING_CONTEXT = `# Main agent tool policy
You have access to typed dashboard and duplicate-search tools. Use them only when the user asks for factual QGate dashboard metrics, counts, filtered summaries, defect/test coverage data, or duplicate/similar defect analysis.
If the supplied context already contains the exact factual result needed, answer normally without calling tools.
Use get_data_catalog first when the user asks a broad analytics question and you need to discover available datasets, filters, metrics, or modules.
Use get_ontology_catalog when the user asks what the ontology can answer, which entities/relationships/tools/actions exist, or which capability states are available/partial/unavailable/dry_run_only/disabled/blocked.
Use Action Ontology capability states for Octane write/update/delete intents. Never execute write/update/delete directly from field candidates; disabled or blocked actions must not be executed, and dry_run_only actions require explicit approval before any external write path.
Use search_octane_fields when the user asks which Octane/API/database field backs a business concept, asks about editable/filterable/sortable fields, or explores CRUD/action schema. Retrieve only top-k field candidates.
Do not load the full Octane field catalog into the prompt; use search_octane_fields as local schema retrieval, then validate facts through governed ontology or analytics tools.
Use resolve_business_terms when Chinese/English business wording needs normalization before choosing filters or metrics.
Routing priority: use governed Ontology semantic tools first when the question fits approved ontology metrics, dimensions, filters, time windows, top-N ranking, records, or lineage.
Use query_semantic_metrics first for aggregate, trend, compare, rank, count, and top-N questions over ontology-governed metrics and dimensions.
Use query_semantic_records for governed Ontology list or drilldown requests.
Use query_traceability for governed Ontology requirement, testcase, test-run, and defect lineage questions when the user asks for lineage rather than testcase drafting.
Never redefine metrics after a semantic tool result; use the returned ontologyVersion, schemaFingerprint, sourceRevision, quality, and metrics as factual evidence.
Use query_analytics as the canonical high-level tool for defect analytics counts, trends, rankings, and aggregate questions when the question is not covered by the semantic tools. It wraps governed defect aggregate execution so you do not need to choose a page-specific endpoint first.
Use query_testing_coverage_project_status for Testing Coverage / manual-run coverage, pass-rate, execution-rate, and below-threshold module questions when the module dimension is FV/FVP. Its rows are grouped by test_week, fv, fvp, status, and count; compute rates from status/count groups instead of querying defects.
Use query_testing_coverage_aida_status for Testing Coverage questions when the user chooses AIDA as the module dimension. Its rows are grouped by test_week, top_aida, status, and count; compute pass rate as Passed count divided by total status count for each AIDA. If business impact must be sorted by associated defect count, also call query_analytics on defects with dimensions ["aida"] and metric defect_count, then join the two results by AIDA.
If query_analytics or another analytics tool returns zero rows, empty groups, or a result that is suspiciously small for the user's wording, call diagnose_analytics_empty with the same query before answering no data. Use the diagnosis to retry with corrected filters, ask one focused clarification, or state a specific data limitation.
Use query_defect_records only after query_analytics returns a drilldown_ref, and only for example tickets.
For Top Issue growth/rising questions, use query_analytics with time.current and time.comparison windows, derived_metrics ["delta", "growth_pct"], and order_by delta desc unless the user asks for another ranking.
For module wording, prefer dimensions ["business_module"] unless the user explicitly asks for assigned_ecu or solution_cluster. When drilling from a returned business_module into ECU details, use filters.business_module or filters.business_modules. Convert relative dates to absolute creation_time dates in Asia/Shanghai before calling analytics tools.
If a dashboard fallback tool is needed, call at most one dashboard tool with precise filters. Do not invent fields, filters, or metrics.
Use ask_clarification when required filters, scope, timeframe, or business meaning are ambiguous. Ask one focused question instead of guessing.
Use query_defect_high_frequency_analysis for Defect High Frequency / 缺陷高频分析 questions about newly created defects concentrated by ECU/module.
For 最近一周 / recent week / last 7 days high-frequency questions, call query_defect_high_frequency_analysis with filters.recent_days: 7 instead of asking the user to switch views.
For high-frequency questions that can be answered as a simple assigned_ecu or business_module ranking, query_analytics is also acceptable; still use diagnose_analytics_empty before answering no data.
Use get_test_case_context before drafting or extending a testcase when the user provides a test_id, defect_id, or asks to create a regression/coverage testcase from known QGate context. For defect-to-testcase workflows, call get_test_case_context first; use query_traceability only if the user explicitly asks for lineage beyond testcase drafting context.
For an Octane ticket URL such as entityType=work_item&id=2774806, extract id=2774806 as anchor.type defect_id and call get_test_case_context; do not stop at external-link access limitations.
Use query_full_picture_module as the fallback for factual Full Picture dashboard questions when no more specific tool fits. Prefer query_analytics first for defect counts/trends/rankings; use query_full_picture_module for page-parity payloads or modules not covered by query_analytics. Choose only one allowlisted module: dashboard_summary, dashboard_tickets, top_issue_analysis, long_runner_analysis, or defect_high_frequency_analysis.`;

function formatPlanningDate(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export function buildToolPlanningContext(now) {
  return [
    TOOL_PLANNING_CONTEXT,
    `# Runtime date\nCurrent date for relative analytics windows: ${formatPlanningDate(now)}. Timezone: Asia/Shanghai.`,
  ].join("\n\n");
}

export { buildSelectedToolsetContext, shouldPlanMainAgentTools };

export function mergeToolContext(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

export function parseToolInput(toolCall) {
  const rawArguments = toolCall?.function?.arguments;
  if (!rawArguments) {
    return {};
  }
  if (typeof rawArguments === "object") {
    return rawArguments;
  }
  try {
    return JSON.parse(String(rawArguments));
  } catch {
    return { raw: String(rawArguments) };
  }
}

function parseToolMessageContent(result) {
  try {
    return JSON.parse(String(result?.toolMessage?.content || "{}"));
  } catch {
    return {};
  }
}

export function hasEmptyAnalyticsResult(toolCall, result) {
  if (toolCall?.function?.name !== "query_analytics") {
    return false;
  }
  const payload = parseToolMessageContent(result);
  const aggregate = payload?.result && typeof payload.result === "object" ? payload.result : {};
  const rows = Array.isArray(aggregate.rows) ? aggregate.rows : null;
  const returnedGroups = Number(aggregate.returned_groups);
  return returnedGroups === 0 || rows?.length === 0 || /Aggregate rows:\s*none/i.test(String(result?.contextText || ""));
}

export function hasPlannedDiagnosis(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).some((toolCall) => toolCall?.function?.name === "diagnose_analytics_empty");
}

export function buildEmptyDiagnosisToolCall(toolCall) {
  return {
    id: `${toolCall?.id || `query-analytics-${Date.now()}`}-diagnosis`,
    type: "function",
    function: {
      name: "diagnose_analytics_empty",
      arguments: JSON.stringify({
        query: parseToolInput(toolCall),
        reason: "query_analytics returned no aggregate rows",
      }),
    },
  };
}
