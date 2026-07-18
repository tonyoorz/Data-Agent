export const ANALYTICS_TOOLS = new Set([
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_defect_high_frequency_analysis",
  "query_full_picture_module",
]);

export const DEFECT_TOOLS = new Set(["search_duplicates"]);
const REGISTERED = new Set([...ANALYTICS_TOOLS, ...DEFECT_TOOLS]);

function deny(code, statusCode = 403, metadata = {}) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false, ...metadata });
}

export function createRuntimePolicy({
  maxExternalSteps = 6,
  maxCallsPerStep = 3,
  runStartRatePerMinute = 30,
  runStartBurst = 5,
  actorActiveRunLimit = 2,
  globalActiveRunLimit = 20,
} = {}) {
  const rateLimit = Object.freeze({ perMinute: runStartRatePerMinute, burst: runStartBurst });
  return Object.freeze({
    rateLimit,
    authorizeRunStart({ counts, rateState }) {
      if (counts.threadActive >= 1) deny("THREAD_BUSY", 409);
      if (counts.actorActive >= actorActiveRunLimit) deny("ACTOR_ACTIVE_RUN_LIMIT", 429, { retryAfterSeconds: 1 });
      if (counts.globalActive >= globalActiveRunLimit) deny("INSTANCE_ACTIVE_RUN_LIMIT", 429, { retryAfterSeconds: 1 });
      const elapsedMinutes = Math.max(0, (rateState.nowMs - rateState.updatedAtMs) / 60000);
      const available = Math.min(rateLimit.burst, rateState.tokens + elapsedMinutes * rateLimit.perMinute);
      if (available < 1) {
        const retryAfterSeconds = Math.max(1, Math.ceil(((1 - available) / Math.max(1, rateLimit.perMinute)) * 60));
        deny("RUN_RATE_LIMITED", 429, { retryAfterSeconds });
      }
      return { tokens: available - 1, updatedAtMs: rateState.nowMs };
    },
    authorizeTool({ request, runtimeMode, toolName, externalStepIndex, callsInStep }) {
      if (!REGISTERED.has(toolName)) deny("TOOL_NOT_REGISTERED", 400);
      if (!Number.isInteger(externalStepIndex) || externalStepIndex < 0 || externalStepIndex >= maxExternalSteps) deny("RUN_STEP_BUDGET_EXCEEDED", 429);
      if (!Number.isInteger(callsInStep) || callsInStep < 1 || callsInStep > maxCallsPerStep) deny("RUN_TOOL_CALL_BUDGET_EXCEEDED", 429);
      if (ANALYTICS_TOOLS.has(toolName) && request.useAnalyticsContext !== true) deny("ANALYTICS_CONTEXT_DISABLED");
      if (DEFECT_TOOLS.has(toolName) && request.useDefectContext !== true) deny("DEFECT_CONTEXT_DISABLED");
      if (runtimeMode === "shadow" && DEFECT_TOOLS.has(toolName)) deny("SHADOW_DUPLICATE_SEARCH_FORBIDDEN");
      return { riskLevel: "R0", toolName };
    },
  });
}
