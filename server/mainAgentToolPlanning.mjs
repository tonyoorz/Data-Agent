import { extractLatestUserQuery } from "./aiContext.mjs";
import { classifyDirectMainAgentIntent } from "./mainAgentDirectIntent.mjs";
import { executeMainAgentToolCall, extractDetectedByName, isDefectReporterTicketQuery, MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";
import { buildToolEvidence } from "./mainAgentEvidence.mjs";
import { executeToolWithRecovery } from "./mainAgentToolRecovery.mjs";
import { selectMainAgentToolset as selectToolsetWithTools } from "./mainAgentIntentRouter.mjs";
import { buildBlockedToolResult, validateToolCallAllowed } from "./mainAgentPolicyGate.mjs";

export function selectMainAgentToolset(messages, priorToolCalls = []) {
  const selectedToolset = selectToolsetWithTools(messages, MAIN_AGENT_TOOLS);
  if (!resolveDefectReporterRequest(messages, priorToolCalls)) {
    return selectedToolset;
  }

  const allowedToolNames = new Set([
    "resolve_business_terms",
    "search_analytics_filter_values",
    "query_analytics",
    "diagnose_analytics_empty",
    "ask_clarification",
  ]);
  const tools = MAIN_AGENT_TOOLS.filter((tool) => allowedToolNames.has(tool.function?.name));
  return {
    ...selectedToolset,
    requiredSlots: [...new Set([...(selectedToolset.requiredSlots || []), "defect_reporter"])],
    policyHints: [...new Set([...(selectedToolset.policyHints || []), "resolve_defect_reporter_before_aggregate"])],
    requiredAnalyticsFilters: ["detected_by"],
    toolNames: tools.map((tool) => tool.function?.name).filter(Boolean),
    tools,
  };
}

const TOOL_PLANNING_CONTEXT = `# Main agent tool policy
You have access to typed dashboard and duplicate-search tools. Use them only when the user asks for factual QGate dashboard metrics, counts, filtered summaries, defect/test coverage data, or duplicate/similar defect analysis.
If the supplied context already contains the exact factual result needed, answer normally without calling tools.
Use get_data_catalog first when the user asks a broad analytics question and you need to discover available datasets, filters, metrics, or modules.
Use get_ontology_catalog when the user asks what the ontology can answer, which entities/relationships/tools/actions exist, or which capability states are available/partial/unavailable/dry_run_only/disabled/blocked.
For broad business risk, health, status, or "how does this look" questions, use get_ontology_catalog to ground the available governed metrics first, then call a small evidence set across defect trend/ranking, testing coverage, and high-frequency analysis before summarizing risk.
Use Action Ontology capability states for Octane write/update/delete intents. Never execute write/update/delete directly from field candidates; disabled or blocked actions must not be executed, and dry_run_only actions require explicit approval before any external write path.
Use search_octane_fields when the user asks which Octane/API/database field backs a business concept, asks about editable/filterable/sortable fields, or explores CRUD/action schema. Retrieve only top-k field candidates.
Do not load the full Octane field catalog into the prompt; use search_octane_fields as local schema retrieval, then validate facts through governed ontology or analytics tools.
Use search_analytics_filter_values before query_analytics when the user supplies a fuzzy or partial detected_by person name, ECU/module, business_module, or team value. Use returned exact values as filters; if none match, ask one focused clarification.
If a tool result reports TOOL_SCHEMA_OR_VALUE_MISMATCH, use governed field or filter-value retrieval and make at most one corrected typed retry. Never generate SQL, loosen authorization scope, or retry a denied request.
Use resolve_business_terms when Chinese/English business wording needs normalization before choosing filters or metrics.
Routing priority: use governed Ontology semantic tools first when the question fits approved ontology metrics, dimensions, filters, time windows, top-N ranking, records, or lineage.
Use query_semantic_metrics first for aggregate, trend, compare, rank, count, and top-N questions over ontology-governed metrics and dimensions.
Use query_semantic_records for governed Ontology list or drilldown requests. When a prior governed semantic result supplies analysis_ref, continue from that ref and only narrow it with explicit selections; never rebuild or widen the original query.
Use query_traceability for governed Ontology requirement, testcase, test-run, and defect lineage questions when the user asks for lineage rather than testcase drafting.
Never redefine metrics after a semantic tool result; use the returned ontologyVersion, schemaFingerprint, sourceRevision, quality, and metrics as factual evidence.
Use query_analytics as the canonical high-level tool for defect analytics counts, trends, rankings, and aggregate questions when the question is not covered by the semantic tools. It wraps governed defect aggregate execution so you do not need to choose a page-specific endpoint first.
Use query_testing_coverage_project_status for Testing Coverage / manual-run coverage, pass-rate, execution-rate, and below-threshold module questions when the module dimension is FV/FVP. Its rows are grouped by test_week, fv, fvp, status, and count; compute rates from status/count groups instead of querying defects.
For a named organization's internal testing groups or 测试小组, use query_testing_team_fv_analysis with the organization team as scope and FV as the group dimension. It returns execution, pass, distinct linked-defect, pass-rate, and defect-discovery-rate values per FV. Never substitute team or tester for FV; tester is only for an explicitly person-level question.
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

const TOOL_PLANNING_QUERY_RE = /\b(DTSV|QGate|Octane|ticket|work_item|dashboard|ontology|capability|available|partial|unavailable|bug|defect|issue|top\s*issue|octane_defects|solution_cluster|assigned_ecu|business_module|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|growth|rising|increase|delta|duplicate|similar|write|update|delete|edit|empty\s*result|no\s*data|zero\s*rows)\b|entityType=work_item|id=\d+|本体|能力|缺陷|测试|覆盖率|多少|几个|统计|趋势|创建|提交|新建|解决|关闭|更新|修改|删除|写入|重复|查重|相似|模块|问题模块|上升|增长|环比|同比|根因|提票|报票|提了|数据.*(?:为空|没数据|没有数据|查不到)|为什么.*(?:为空|没数据|没有数据|查不到)|空结果/i;

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

export function shouldPlanMainAgentTools(messages) {
  const queryText = extractLatestUserQuery(messages);
  if (classifyDirectMainAgentIntent(queryText)) return false;
  return Boolean(resolveDefectReporterRequest(messages)) || TOOL_PLANNING_QUERY_RE.test(queryText);
}

export function mergeToolContext(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

export function buildSelectedToolsetContext(selectedToolset) {
  const toolNames = (selectedToolset?.tools || []).map((tool) => tool.function?.name).filter(Boolean).join(", ");
  const defectReporterGuard = selectedToolset?.policyHints?.includes("resolve_defect_reporter_before_aggregate")
    ? "\n# Defect reporter guard\nThis is a named personal ticket-reporting query. First use search_analytics_filter_values for detected_by, then use its exact candidate in query_analytics. If candidates are missing or ambiguous, call ask_clarification. Never answer it with a team-only aggregate."
    : "";
  return `# Selected toolset\nIntent: ${selectedToolset?.intent || "general"}. Tools: ${toolNames}.${defectReporterGuard}`;
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
    .join("\n");
}

function normalizedBarePersonName(text) {
  const raw = String(text || "").trim();
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(raw)) {
    return "";
  }
  return raw
    .split(/\s+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function hasPriorDefectReporterLookup(priorToolCalls) {
  return priorToolCalls.some((toolCall) => (
    String(toolCall?.id || "").startsWith("defect-reporter-")
    && toolCall?.function?.name === "search_analytics_filter_values"
    && parseToolInput(toolCall).field === "detected_by"
  ));
}

function resolveDefectReporterRequest(messages, priorToolCalls = []) {
  const queryText = extractLatestUserQuery(messages);
  if (isDefectReporterTicketQuery(queryText)) {
    const reporter = extractDetectedByName(queryText);
    return reporter ? { reporter, isContinuation: false } : null;
  }

  const userMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .map(messageText)
    .filter(Boolean);
  const continuationCommand = /^(?:继续(?:未完成)?|continue)$/i.test(String(queryText || "").trim());
  const reporter = normalizedBarePersonName(queryText)
    || (continuationCommand
      ? userMessages.slice(0, -1).reverse().map(normalizedBarePersonName).find(Boolean) || ""
      : "");
  if (!reporter) {
    return null;
  }
  const hasPriorReporterQuestion = userMessages.slice(0, -1).some(isDefectReporterTicketQuery);
  return hasPriorReporterQuestion || hasPriorDefectReporterLookup(priorToolCalls)
    ? { reporter, isContinuation: true }
    : null;
}

function reporterToolKey(reporter) {
  return String(reporter || "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function reporterToolId(reporter, suffix) {
  return `defect-reporter-${reporterToolKey(reporter)}-${suffix}`;
}

function reversedReporterName(reporter) {
  const tokens = String(reporter || "").trim().split(/\s+/).filter(Boolean);
  return tokens.length === 2 ? [tokens[1], tokens[0]].join(" ") : "";
}

function sameReporterName(left, right) {
  return String(left || "").trim().toLocaleLowerCase("en-US") === String(right || "").trim().toLocaleLowerCase("en-US");
}

function lookupForReporter(priorToolCalls, reporter) {
  return [...priorToolCalls].reverse().find((toolCall) => {
    if (toolCall?.function?.name !== "search_analytics_filter_values") {
      return false;
    }
    const input = parseToolInput(toolCall);
    return input.dataset === "defects"
      && input.field === "detected_by"
      && sameReporterName(input.query, reporter);
  });
}

export function buildDefectReporterLookupToolCall(messages, priorToolCalls = []) {
  const reporterRequest = resolveDefectReporterRequest(messages, priorToolCalls);
  if (!reporterRequest) {
    return null;
  }
  if (lookupForReporter(priorToolCalls, reporterRequest.reporter)) {
    return null;
  }

  return {
    id: reporterToolId(reporterRequest.reporter, "filter-values"),
    type: "function",
    function: {
      name: "search_analytics_filter_values",
      arguments: JSON.stringify({
        dataset: "defects",
        field: "detected_by",
        query: reporterRequest.reporter,
        limit: 5,
      }),
    },
  };
}

function lookupValuesForDefectReporter(toolMessages, lookupToolCall) {
  const lookupToolCallId = String(lookupToolCall?.id || "");
  const toolMessage = [...toolMessages].reverse().find((message) => (
    message?.name === "search_analytics_filter_values"
    && String(message?.tool_call_id || "") === lookupToolCallId
  ));
  if (!toolMessage) {
    return null;
  }
  try {
    const payload = JSON.parse(String(toolMessage.content || "{}"));
    const values = Array.isArray(payload?.result?.values) ? payload.result.values : [];
    return values
      .map((item) => String(item?.value || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildDefectReporterAliasLookupToolCall({ messages, toolMessages = [], priorToolCalls = [] } = {}) {
  const reporterRequest = resolveDefectReporterRequest(messages, priorToolCalls);
  if (!reporterRequest) {
    return null;
  }

  const primaryLookup = lookupForReporter(priorToolCalls, reporterRequest.reporter);
  const primaryValues = lookupValuesForDefectReporter(toolMessages, primaryLookup);
  const alias = reversedReporterName(reporterRequest.reporter);
  if (!Array.isArray(primaryValues) || primaryValues.length !== 0 || !alias || lookupForReporter(priorToolCalls, alias)) {
    return null;
  }

  return {
    id: reporterToolId(alias, "filter-values"),
    type: "function",
    function: {
      name: "search_analytics_filter_values",
      arguments: JSON.stringify({
        dataset: "defects",
        field: "detected_by",
        query: alias,
        limit: 5,
      }),
    },
  };
}

export function buildDefectReporterAggregateToolCall({ messages, toolMessages = [], priorToolCalls = [], now = new Date() } = {}) {
  const reporterRequest = resolveDefectReporterRequest(messages, priorToolCalls);
  if (!reporterRequest) {
    return null;
  }

  const reporterNames = [reversedReporterName(reporterRequest.reporter), reporterRequest.reporter].filter(Boolean);
  const candidateValues = reporterNames
    .map((reporter) => lookupValuesForDefectReporter(toolMessages, lookupForReporter(priorToolCalls, reporter)))
    .find((values) => Array.isArray(values) && values.length === 1);
  if (!candidateValues) {
    return null;
  }
  const [detectedBy] = candidateValues;

  const alreadyAggregated = priorToolCalls.some((toolCall) => {
    if (toolCall?.function?.name !== "query_analytics") {
      return false;
    }
    const values = parseToolInput(toolCall).filters?.detected_by;
    return Array.isArray(values) && values.includes(detectedBy);
  });
  if (alreadyAggregated) {
    return null;
  }

  const today = formatPlanningDate(now);
  return {
    id: reporterToolId(detectedBy, "aggregate"),
    type: "function",
    function: {
      name: "query_analytics",
      arguments: JSON.stringify({
        dataset: "defects",
        intent: "aggregate",
        metrics: ["defect_count"],
        dimensions: [],
        filters: { detected_by: [detectedBy] },
        time: {
          field: "creation_time",
          current: [`${today.slice(0, 4)}-01-01`, today],
          timezone: "Asia/Shanghai",
        },
        limit: 20,
      }),
    },
  };
}

export function buildDefectReporterClarificationToolCall({ messages, toolMessages = [], priorToolCalls = [] } = {}) {
  const reporterRequest = resolveDefectReporterRequest(messages, priorToolCalls);
  if (!reporterRequest) {
    return null;
  }
  const clarificationId = reporterToolId(reporterRequest.reporter, "clarification");
  if (priorToolCalls.some((toolCall) => toolCall?.id === clarificationId)) {
    return null;
  }

  const primaryLookup = lookupForReporter(priorToolCalls, reporterRequest.reporter);
  const primaryValues = lookupValuesForDefectReporter(toolMessages, primaryLookup);
  if (!Array.isArray(primaryValues)) {
    return null;
  }
  const alias = reversedReporterName(reporterRequest.reporter);
  const aliasLookup = alias ? lookupForReporter(priorToolCalls, alias) : null;
  if (primaryValues.length === 0 && alias && !aliasLookup) {
    return null;
  }
  const aliasValues = aliasLookup ? lookupValuesForDefectReporter(toolMessages, aliasLookup) : null;
  if (aliasLookup && !Array.isArray(aliasValues)) {
    return null;
  }
  const candidateValues = primaryValues.length === 0 && Array.isArray(aliasValues) ? aliasValues : primaryValues;
  if (candidateValues.length === 1) {
    return null;
  }

  const ambiguous = candidateValues.length > 1;
  return {
    id: clarificationId,
    type: "function",
    function: {
      name: "ask_clarification",
      arguments: JSON.stringify({
        question: ambiguous
          ? `找到多个与 ${reporterRequest.reporter} 相近的缺陷提票人，请确认 Octane 中的姓名。`
          : `未找到与 ${reporterRequest.reporter} 匹配的缺陷提票人，请提供 Octane 中显示的姓名。`,
        options: ambiguous
          ? [...candidateValues.slice(0, 5), "以上都不是"]
          : ["提供 Octane 姓名", "改查测试执行情况", "取消"],
        reason: ambiguous
          ? "detected_by 候选不唯一，不能猜测个人身份。"
          : "detected_by 候选为空，不能用团队汇总代替个人提票数据。",
      }),
    },
  };
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

function missingRequiredAnalyticsFilter(toolCall, selectedToolset) {
  if (toolCall?.function?.name !== "query_analytics") {
    return false;
  }
  const requiredFilters = Array.isArray(selectedToolset?.requiredAnalyticsFilters)
    ? selectedToolset.requiredAnalyticsFilters
    : [];
  if (!requiredFilters.length) {
    return false;
  }
  const filters = parseToolInput(toolCall).filters;
  return requiredFilters.some((field) => {
    const value = filters?.[field];
    return Array.isArray(value) ? value.length === 0 : !String(value || "").trim();
  });
}

export async function executeMainAgentPlannedToolCall({
  toolCall,
  selectedToolset,
  executeToolCall = executeMainAgentToolCall,
  toolDependencies = {},
} = {}) {
  const toolName = toolCall?.function?.name || "unknown_tool";
  const toolEvents = [{
    type: "tool-input-available",
    toolCallId: toolCall?.id || "",
    toolName,
    input: parseToolInput(toolCall),
  }];

  const baseGate = validateToolCallAllowed(toolCall, selectedToolset);
  const gate = baseGate.allowed && missingRequiredAnalyticsFilter(toolCall, selectedToolset)
    ? { allowed: false, reason: "defect_reporter_filter_required" }
    : baseGate;
  if (!gate.allowed) {
    const blockedResult = buildBlockedToolResult(toolCall, selectedToolset, gate.reason);
    toolEvents.push({
      type: "tool-blocked",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset?.intent,
      reason: gate.reason,
    });
    return {
      result: blockedResult,
      toolEvents,
      evidence: null,
      stoppedReason: "tool_not_allowed",
      blocked: true,
    };
  }

  const recovered = await executeToolWithRecovery({
    toolCall,
    executeToolCall,
    toolDependencies,
  });
  const result = recovered.result;
  if (recovered.recovery.action !== "none") {
    toolEvents.push({
      type: "tool-recovery",
      toolCallId: toolCall?.id || "",
      toolName,
      recovery: recovered.recovery,
    });
  }
  if (recovered.recovery.action === "deny") {
    toolEvents.push({
      type: "tool-blocked",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset?.intent,
      reason: recovered.recovery.reason,
    });
  }
  toolEvents.push({
    type: "tool-output-available",
    toolCallId: toolCall?.id || "",
    toolName,
    outputSummary: result.contextText,
  });
  return {
    result,
    toolEvents,
    evidence: buildToolEvidence({ toolCall, result, intent: selectedToolset?.intent }),
    recovery: recovered.recovery,
    stoppedReason: result.requiresUserInput
      ? "clarification_requested"
      : recovered.recovery.action === "deny"
        ? "tool_access_denied"
        : recovered.recovery.action === "retry" && recovered.recovery.outcome === "exhausted"
          ? "tool_recovery_exhausted"
          : recovered.recovery.action === "catalog"
            ? "tool_recovery_catalog"
          : recovered.recovery.action === "stop"
            ? "tool_recovery_stopped"
          : "",
    blocked: recovered.recovery.action === "deny",
  };
}
