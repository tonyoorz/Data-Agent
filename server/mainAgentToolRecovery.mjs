import { createHash } from "node:crypto";

const TRANSIENT_STATUS_CODES = new Set([408, 429]);
const ACCESS_DENIAL_CODE = /(DENIED|FORBIDDEN|UNAUTHORIZED|SCOPE|SENSITIVE|PERMISSION|POLICY|ACTOR_CAPABILITY|ACTION_BLOCKED|UNSCOPED_TOOL_DISABLED)/i;
const SCHEMA_OR_VALUE_CODE = /(SCHEMA|DIMENSION|FIELD|FILTER|VALUE|METRIC).*(INVALID|NOT_FOUND|MISMATCH|UNSUPPORTED|NOT_ALLOWED)|(?:ONTOLOGY_)?METRIC_NOT_APPROVED|UNSUPPORTED_(?:DEFECT_)?(?:FILTER|METRIC|DIMENSION)/i;
const RETRYABLE_READ_TOOLS = new Set([
  "catalog",
  "resolve",
  "analyze",
  "records",
  "trace",
  "duplicate_search",
  "prepare_testcase",
  "get_ontology_catalog",
  "search_octane_fields",
  "search_analytics_filter_values",
  "query_analytics",
  "diagnose_analytics_empty",
  "query_analytics_fallback",
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_testing_coverage_aida_status",
  "get_test_case_context",
  "query_defect_high_frequency_analysis",
  "query_defect_aggregate",
  "query_defect_records",
  "query_full_picture_module",
  "search_duplicates",
]);
const ANALYTICS_QUERY_KEYS = new Set([
  "dataset",
  "intent",
  "metrics",
  "dimensions",
  "derived_metrics",
  "filters",
  "time",
  "order_by",
  "min_baseline_count",
  "limit",
  "reason",
]);
const SEMANTIC_QUERY_TOOLS = new Set([
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
]);

function asPositiveStatus(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : 0;
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value) {
  if (isRecord(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSafeFilterValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSafeFilterObject(filters) {
  return isRecord(filters) && Object.entries(filters).every(([field, values]) => (
    /^[a-z][a-z0-9_]*$/i.test(field)
    && Array.isArray(values)
    && values.length > 0
    && values.every(isSafeFilterValue)
  ));
}

function isSafeAnalyticsQuery(query) {
  return isRecord(query)
    && Object.keys(query).every((key) => ANALYTICS_QUERY_KEYS.has(key))
    && query.dataset === "defects"
    && isSafeFilterObject(query.filters || {});
}

function hasForbiddenExecutionField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenExecutionField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => /^(?:sql|code|script|command)$/i.test(key) || hasForbiddenExecutionField(item));
}

function errorCode(failure) {
  return safeText(failure?.code || failure?.error?.code || failure?.failure?.code);
}

function errorMessage(failure) {
  if (failure?.error instanceof Error) return safeText(failure.error.message);
  return safeText(failure?.message || failure?.error || failure?.failure?.message);
}

function errorStatus(failure) {
  const direct = asPositiveStatus(failure?.statusCode || failure?.status || failure?.failure?.statusCode);
  if (direct) return direct;
  const match = /(?:status|http|failed(?:\s+for\s+\S+)?):?\s*(408|429|[5]\d\d|401|403)\b/i.exec(errorMessage(failure));
  return match ? Number(match[1]) : 0;
}

function isTransientFailure(failure, statusCode) {
  if (failure?.retryable === true || failure?.failure?.retryable === true) return true;
  if (TRANSIENT_STATUS_CODES.has(statusCode) || statusCode >= 500) return true;
  return /(?:fetch failed|network|timeout|temporarily unavailable|connection reset)/i.test(errorMessage(failure));
}

function failureFromToolResult(result) {
  const content = String(result?.toolMessage?.content || "");
  try {
    const payload = JSON.parse(content);
    if (payload?.ok === false || payload?.error || payload?.failure) {
      return {
        code: safeText(payload?.failure?.code || payload?.code),
        statusCode: asPositiveStatus(payload?.failure?.statusCode || payload?.statusCode),
        retryable: payload?.failure?.retryable === true || payload?.retryable === true,
        message: safeText(payload?.error || payload?.failure?.message),
      };
    }
  } catch {
    // A non-JSON tool result is not a structured failure.
  }
  return null;
}

function safeFailureResult(toolCall, recovery) {
  const toolName = toolCall?.function?.name || "unknown_tool";
  const error = recovery.action === "deny"
    ? "TOOL_ACCESS_DENIED"
    : recovery.action === "retry"
      ? "TOOL_TEMPORARILY_UNAVAILABLE"
      : recovery.action === "catalog"
        ? "TOOL_SCHEMA_OR_VALUE_MISMATCH"
        : "TOOL_EXECUTION_FAILED";
  const guidance = recovery.action === "catalog"
    ? "Use governed field or filter-value retrieval before one corrected typed retry."
    : recovery.action === "deny"
      ? "This request is not available in the current authorized scope."
      : recovery.action === "retry"
        ? "The read service remained unavailable after one bounded retry."
        : "The tool could not complete safely.";
  return {
    toolMessage: {
      role: "tool",
      tool_call_id: toolCall?.id || "",
      name: toolName,
      content: JSON.stringify({ ok: false, tool: toolName, error, recovery }),
    },
    contextText: [
      "# Main agent tool result",
      `Tool: ${toolName}`,
      `Result: ${guidance}`,
    ].join("\n"),
  };
}

function defaultWaitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function queryFingerprint(toolCall) {
  const rawArguments = toolCall?.function?.arguments;
  const source = typeof rawArguments === "string"
    ? rawArguments
    : JSON.stringify(rawArguments ?? {});
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 24);
}

function aliasCandidate(diagnosis) {
  const candidates = Array.isArray(diagnosis?.candidateValues) ? diagnosis.candidateValues : [];
  const matching = candidates.filter((candidate) => candidate?.field === "detected_by"
    && safeText(candidate?.value)
    && Number(candidate?.count) > 0);
  return matching.length === 1 ? safeText(matching[0].value) : "";
}

function isVerifiedAliasReplacement({ originalFilters, retryFilters, alias }) {
  if (!isSafeFilterObject(originalFilters) || !isSafeFilterObject(retryFilters)) return false;
  const originalKeys = Object.keys(originalFilters).sort();
  const retryKeys = Object.keys(retryFilters).sort();
  if (canonicalJson(originalKeys) !== canonicalJson(retryKeys)) return false;
  if (!Array.isArray(originalFilters.detected_by) || originalFilters.detected_by.length !== 1) return false;
  if (canonicalJson(retryFilters.detected_by) !== canonicalJson([alias])) return false;
  return originalKeys
    .filter((field) => field !== "detected_by")
    .every((field) => canonicalJson(originalFilters[field]) === canonicalJson(retryFilters[field]));
}

export function buildCatalogBackedAnalyticsRetry({ originalToolCall, diagnosisToolCall, diagnosisResult } = {}) {
  if (originalToolCall?.function?.name !== "query_analytics" || diagnosisToolCall?.function?.name !== "diagnose_analytics_empty") return null;
  const originalQuery = parseJsonRecord(originalToolCall?.function?.arguments);
  const diagnosisPayload = parseJsonRecord(diagnosisResult?.toolMessage?.content);
  const diagnosis = diagnosisPayload?.ok === true && diagnosisPayload?.tool === "diagnose_analytics_empty" && isRecord(diagnosisPayload.result)
    ? diagnosisPayload.result
    : null;
  if (!isSafeAnalyticsQuery(originalQuery) || diagnosis?.causeCode !== "FILTER_VALUE_ALIAS" || !isRecord(diagnosis.retryQuery)) return null;
  const alias = aliasCandidate(diagnosis);
  const originalFilters = originalQuery.filters;
  const retryFilters = diagnosis.retryQuery.filters;
  if (!alias || !isVerifiedAliasReplacement({ originalFilters, retryFilters, alias })) return null;

  const correctedQuery = {
    ...originalQuery,
    filters: { ...originalFilters, detected_by: [alias] },
  };
  const correctedToolCall = {
    id: `${originalToolCall.id || "query-analytics"}-catalog-retry`,
    type: "function",
    function: {
      name: "query_analytics",
      arguments: JSON.stringify(correctedQuery),
    },
  };
  const originalQueryFingerprint = queryFingerprint(originalToolCall);
  const revisedQueryFingerprint = queryFingerprint(correctedToolCall);
  return {
    toolCall: correctedToolCall,
    recovery: {
      action: "catalog",
      retryable: false,
      maxAttempts: 1,
      reason: "filter_value_alias",
      attempts: 1,
      outcome: "planned",
      queryFingerprint: originalQueryFingerprint,
      originalQueryFingerprint,
      revisedQueryFingerprint,
      sourceToolCallId: String(originalToolCall.id || ""),
      diagnosisToolCallId: String(diagnosisToolCall.id || ""),
    },
  };
}

export function buildGovernedSemanticPlanRetry({ originalToolCall, recovery, queryPlan, actorScopeHash } = {}) {
  const toolName = String(originalToolCall?.function?.name || "");
  if (recovery?.action !== "catalog" || !SEMANTIC_QUERY_TOOLS.has(toolName)) return null;
  if (queryPlan?.status !== "valid" || String(queryPlan?.actorScopeHash || "") !== String(actorScopeHash || "")) return null;
  const matchingSteps = (Array.isArray(queryPlan.steps) ? queryPlan.steps : [])
    .filter((step) => step?.toolName === toolName && isRecord(step?.canonicalArgs) && !hasForbiddenExecutionField(step.canonicalArgs));
  if (matchingSteps.length !== 1) return null;

  const correctedToolCall = {
    id: `${originalToolCall?.id || toolName}-governed-plan-retry`,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(matchingSteps[0].canonicalArgs),
    },
  };
  const originalQueryFingerprint = queryFingerprint(originalToolCall);
  const revisedQueryFingerprint = queryFingerprint(correctedToolCall);
  return {
    toolCall: correctedToolCall,
    recovery: {
      action: "catalog",
      retryable: false,
      maxAttempts: 1,
      reason: "governed_query_plan",
      attempts: 1,
      outcome: "planned",
      queryFingerprint: originalQueryFingerprint,
      originalQueryFingerprint,
      revisedQueryFingerprint,
      sourceToolCallId: String(originalToolCall?.id || ""),
      ...(queryPlan?.planId ? { sourcePlanId: String(queryPlan.planId) } : {}),
    },
  };
}

export function completeCatalogBackedAnalyticsRetry({ recovery, result, stoppedReason = "" } = {}) {
  if (!recovery) return null;
  const payload = parseJsonRecord(result?.toolMessage?.content);
  const aggregate = isRecord(payload?.result) ? payload.result : {};
  const empty = Number(aggregate.returned_groups) === 0
    || (Array.isArray(aggregate.rows) && aggregate.rows.length === 0);
  const outcome = stoppedReason
    ? stoppedReason === "tool_access_denied" ? "denied" : "failed"
    : payload?.ok === false ? "failed"
      : empty ? "empty"
        : "recovered";
  return { ...recovery, outcome };
}

export function classifyToolFailure({ toolName, code, statusCode, retryable, error, message, failure } = {}) {
  const normalizedCode = safeText(code || errorCode({ error, failure }));
  const normalizedStatus = asPositiveStatus(statusCode || errorStatus({ error, message, failure }));
  const normalizedMessage = safeText(message || errorMessage({ error, failure }));
  const normalizedFailure = { code: normalizedCode, statusCode: normalizedStatus, retryable, error, message: normalizedMessage, failure };
  if (normalizedCode === "EMPTY_RESULT") {
    return { action: "diagnose", retryable: false, maxAttempts: 1, reason: "empty_analytics_result" };
  }
  if (normalizedStatus === 401 || normalizedStatus === 403 || ACCESS_DENIAL_CODE.test(`${normalizedCode} ${normalizedMessage}`)) {
    return { action: "deny", retryable: false, maxAttempts: 1, reason: "policy_or_scope_denied" };
  }
  if (SCHEMA_OR_VALUE_CODE.test(normalizedCode)) {
    return { action: "catalog", retryable: false, maxAttempts: 1, reason: "schema_or_value_mismatch" };
  }
  if (RETRYABLE_READ_TOOLS.has(String(toolName || "")) && isTransientFailure(normalizedFailure, normalizedStatus)) {
    return { action: "retry", retryable: true, maxAttempts: 2, reason: "transient_read_failure" };
  }
  return { action: "stop", retryable: false, maxAttempts: 1, reason: "non_retryable_failure" };
}

export async function executeToolWithRecovery({
  toolCall,
  executeToolCall,
  toolDependencies = {},
  waitForRetry = toolDependencies.toolRecoveryWait || defaultWaitForRetry,
  random = toolDependencies.toolRecoveryRandom || Math.random,
} = {}) {
  const toolName = toolCall?.function?.name || "unknown_tool";
  const inputFingerprint = queryFingerprint(toolCall);
  let attempts = 0;
  let priorRetry = null;

  while (attempts < 2) {
    attempts += 1;
    let result;
    let failure;
    try {
      result = await executeToolCall(toolCall, toolDependencies);
      failure = failureFromToolResult(result);
    } catch (error) {
      failure = { error, code: error?.code, statusCode: error?.statusCode || error?.status, retryable: error?.retryable === true };
    }

    if (!failure) {
      return {
        result,
        recovery: priorRetry
          ? { ...priorRetry, attempts, outcome: "recovered" }
          : {
              action: "none",
              retryable: false,
              maxAttempts: 1,
              reason: "success",
              attempts,
              outcome: "success",
              queryFingerprint: inputFingerprint,
            },
      };
    }

    const decision = classifyToolFailure({ toolName, ...failure });
    if (decision.action === "retry" && attempts < decision.maxAttempts) {
      priorRetry = { ...decision, queryFingerprint: inputFingerprint };
      const delayMs = 50 + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 50);
      await waitForRetry(delayMs);
      continue;
    }

    const outcome = decision.action === "deny" ? "denied" : decision.action === "retry" ? "exhausted" : "stopped";
    const recovery = { ...decision, attempts, outcome, queryFingerprint: inputFingerprint };
    return { result: safeFailureResult(toolCall, recovery), recovery };
  }

  const recovery = {
    action: "stop",
    retryable: false,
    maxAttempts: 1,
    reason: "recovery_loop_exhausted",
    attempts,
    outcome: "stopped",
    queryFingerprint: inputFingerprint,
  };
  return { result: safeFailureResult(toolCall, recovery), recovery };
}
