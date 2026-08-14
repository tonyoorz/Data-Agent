import { extractLatestUserQuery } from "./aiContext.mjs";
import { classifyDirectMainAgentIntent } from "./mainAgentDirectIntent.mjs";
import { executeMainAgentToolCall, extractDetectedByName, isDefectReporterTicketQuery } from "./mainAgentTools.mjs";
import { buildToolEvidence } from "./mainAgentEvidence.mjs";
import { expandPrimitiveToolCall, MAIN_AGENT_PRIMITIVE_TOOLS, toPrimitiveToolCall } from "./mainAgentPrimitives.mjs";
import { executeToolWithRecovery } from "./mainAgentToolRecovery.mjs";
import { selectMainAgentToolset as selectToolsetWithTools } from "./mainAgentIntentRouter.mjs";
import { buildBlockedToolResult, validateToolCallAllowed } from "./mainAgentPolicyGate.mjs";

export function selectMainAgentToolset(messages, priorToolCalls = []) {
  const selectedToolset = selectToolsetWithTools(messages, MAIN_AGENT_PRIMITIVE_TOOLS);
  if (!resolveDefectReporterRequest(messages, priorToolCalls)) {
    return selectedToolset;
  }

  const allowedToolNames = new Set(["resolve", "analyze"]);
  const tools = MAIN_AGENT_PRIMITIVE_TOOLS.filter((tool) => allowedToolNames.has(tool.function?.name));
  return {
    ...selectedToolset,
    requiredSlots: [...new Set([...(selectedToolset.requiredSlots || []), "defect_reporter"])],
    policyHints: [...new Set([...(selectedToolset.policyHints || []), "resolve_defect_reporter_before_aggregate"])],
    requiredAnalyticsFilters: ["detected_by"],
    toolNames: tools.map((tool) => tool.function?.name).filter(Boolean),
    tools,
  };
}

const TOOL_PLANNING_CONTEXT = `# Governed agent primitive policy
You have seven composable primitives: catalog, resolve, analyze, records, trace, duplicate_search, and prepare_testcase. These are semantic capabilities, not raw API endpoints.
If supplied context already contains the exact factual result, answer without calling another primitive.
Use catalog for governed data/ontology discovery or top-k Octane field retrieval. Catalog context is never execution permission.
Use resolve for business-term normalization and exact filter-value linking before analysis; never guess a person, team, ECU, or module identifier.
Use analyze for aggregate, compare, trend, rank, coverage, testing-team, high-frequency, or allowlisted dashboard questions. Prefer operation semantic_metrics when the governed Ontology plan supports the question. Use defect_aggregate only for supported gaps. For Top Issue growth use current/comparison windows, delta and growth_pct, ordered by delta descending.
Use records for lists and drilldowns. Prefer operation semantic with the prior analysis_ref and only narrow selections; never reconstruct or widen the original actor, filter, time, or snapshot scope.
Use trace for governed requirement, testcase, test-run, and defect lineage.
Use duplicate_search only for similarity reasoning, never population statistics or causality.
Use prepare_testcase for proposal context from a defect/testcase anchor. It can never commit or mutate Octane.
Clarification is a runtime state, not a model-visible tool: if a required filter, scope, timeframe, identity, or business meaning is ambiguous, return one focused question in normal text and do not call a data primitive.
Never submit SQL, code, endpoint names, actor scope, authorization fields, or arbitrary datasets. Runtime policy binds identity and RLS, expands primitives through private adapters, performs bounded empty-result recovery, and validates evidence.
Never redefine a governed metric after execution. Treat ontologyVersion, schemaFingerprint, sourceRevision, analysisRef, scope, quality, and EvidenceEnvelope as the factual contract.
For named defect reporters, first resolve operation filter_values for detected_by, then analyze operation defect_aggregate with that exact value. Never substitute a team aggregate.
For testing coverage use analyze operation coverage_project or coverage_aida. For an organization's internal testing groups use testing_team_fv; FV is the group dimension, not tester.
For recent high-frequency questions use analyze operation defect_high_frequency with recent_days 7. For module wording prefer business_module unless the user explicitly requests assigned_ecu or solution_cluster.
For an Octane ticket URL, extract id as a defect_id anchor and use prepare_testcase. Use trace only when lineage itself is requested.
On empty or suspicious results, do not conclude no data immediately; runtime performs one bounded diagnosis/correction before publication.`;

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

export function privateAdapterToolCall(toolCall) {
  try {
    return expandPrimitiveToolCall(toolCall).adapterCall;
  } catch {
    return toolCall;
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
  if (privateAdapterToolCall(toolCall)?.function?.name !== "query_analytics") {
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
  const adapterCall = privateAdapterToolCall(toolCall);
  return {
    id: `${toolCall?.id || `query-analytics-${Date.now()}`}-diagnosis`,
    type: "function",
    function: {
      name: "diagnose_analytics_empty",
      arguments: JSON.stringify({
        query: parseToolInput(adapterCall),
        reason: "query_analytics returned no aggregate rows",
      }),
    },
  };
}

function missingRequiredAnalyticsFilter(toolCall, selectedToolset) {
  const adapterCall = privateAdapterToolCall(toolCall);
  if (adapterCall?.function?.name !== "query_analytics") {
    return false;
  }
  const requiredFilters = Array.isArray(selectedToolset?.requiredAnalyticsFilters)
    ? selectedToolset.requiredAnalyticsFilters
    : [];
  if (!requiredFilters.length) {
    return false;
  }
  const filters = parseToolInput(adapterCall).filters;
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
  const publicToolCall = toPrimitiveToolCall(toolCall) || toolCall;
  const compatibilityAdapterCall = publicToolCall !== toolCall;
  const toolName = publicToolCall?.function?.name || "unknown_tool";
  const toolEvents = [{
    type: "tool-input-available",
    toolCallId: toolCall?.id || "",
    toolName,
    input: parseToolInput(publicToolCall),
  }];

  const internalRuntimeTool = ["ask_clarification", "diagnose_analytics_empty"].includes(toolCall?.function?.name);
  const baseGate = internalRuntimeTool
    ? { allowed: true, toolName: `runtime_${toolCall.function.name}` }
    : validateToolCallAllowed(publicToolCall, selectedToolset);
  const gate = baseGate.allowed && missingRequiredAnalyticsFilter(toolCall, selectedToolset)
    ? { allowed: false, reason: "defect_reporter_filter_required" }
    : baseGate;
  if (!gate.allowed) {
    const blockedResult = buildBlockedToolResult(publicToolCall, selectedToolset, gate.reason);
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
    toolCall: internalRuntimeTool || compatibilityAdapterCall ? toolCall : publicToolCall,
    executeToolCall: async (executingToolCall, dependencies) => {
      if (internalRuntimeTool || compatibilityAdapterCall || executeToolCall === executeMainAgentToolCall) {
        return executeToolCall(executingToolCall, dependencies);
      }
      const expansion = expandPrimitiveToolCall(executingToolCall, { governedQueryPlan: dependencies.governedQueryPlan });
      const adapterResult = await executeToolCall(expansion.adapterCall, dependencies);
      const { wrapPrimitiveResult } = await import("./mainAgentPrimitives.mjs");
      return wrapPrimitiveResult(executingToolCall, expansion, adapterResult);
    },
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
    evidence: buildToolEvidence({
      toolCall: publicToolCall,
      result,
      intent: selectedToolset?.intent,
      actorScope: toolDependencies?.actor,
    }),
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
