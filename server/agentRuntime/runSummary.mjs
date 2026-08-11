import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:actorid|authorization|token|secret|password|apikey|api_key|input|output|content|message|query|prompt|detected_by|ticket|title|description|name|email)/i;
const SAFE_KEYS = new Set([
  "intent",
  "outcome",
  "evidenceStatus",
  "toolOutcomes",
  "recovery",
  "recoveryOutcomes",
  "failureCode",
  "sourceRevisionIds",
  "citationValidation",
  "terminalStatus",
  "latencyMs",
  "recordedAt",
  "type",
  "queryFingerprint",
  "action",
  "attempts",
  "reason",
  "maxAttempts",
  "retryable",
  "stoppedReason",
  "violations",
  "businessRuleCodes",
]);
const SAFE_TOOL_NAMES = new Set([
  "get_data_catalog",
  "get_ontology_catalog",
  "search_octane_fields",
  "search_analytics_filter_values",
  "resolve_business_terms",
  "query_analytics",
  "diagnose_analytics_empty",
  "query_analytics_fallback",
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_testing_coverage_aida_status",
  "query_testing_team_fv_analysis",
  "get_test_case_context",
  "query_defect_high_frequency_analysis",
  "query_defect_aggregate",
  "query_defect_records",
  "query_full_picture_module",
  "search_duplicates",
  "ask_clarification",
]);
const SAFE_TIMELINE_TYPES = new Set([
  "agent-runtime-started",
  "analytics-context-started",
  "defect-context-started",
  "governed-analysis-plan-ready",
  "tool-routing-completed",
  "tool-planning-started",
  "agent-runtime-ready",
  "agent-runtime-failed",
  "agent-stream-completed",
]);
const TERMINAL_OUTCOMES = new Set(["completed", "blocked", "failed"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function count(values) {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(map, key) {
  if (!key) return;
  map[key] = Number(map[key] || 0) + 1;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))];
}

function outcomeFromStoppedReason(stoppedReason) {
  if (/denied|not_allowed/i.test(String(stoppedReason || ""))) return "denied";
  if (/recovery_(?:exhausted|stopped|catalog)/i.test(String(stoppedReason || ""))) return "failed";
  return "completed";
}

function operationalOutcome(rawSummary, stream) {
  const terminalStatus = String(stream?.terminalStatus || "");
  const runtimeOutcome = String(rawSummary?.outcome || "completed");
  if (!TERMINAL_OUTCOMES.has(terminalStatus)) return runtimeOutcome;
  // A successfully delivered policy denial is still a denied run. Blocked and
  // failed terminal states, however, must override any pre-stream "completed" summary.
  return terminalStatus === "completed" && runtimeOutcome !== "completed"
    ? runtimeOutcome
    : terminalStatus;
}

export function redactAuditPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditPayload(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "toolName") {
      return [key, SAFE_TOOL_NAMES.has(String(item || "")) ? String(item) : REDACTED];
    }
    if (key === "toolNames") {
      const names = Array.isArray(item) ? item : [];
      return [key, names.map(String).filter((name) => SAFE_TOOL_NAMES.has(name))];
    }
    if (SAFE_KEYS.has(key)) {
      return [key, redactAuditPayload(item)];
    }
    if (SENSITIVE_KEY.test(key)) {
      return [key, REDACTED];
    }
    return [key, REDACTED];
  }));
}

function publicRecovery(recovery) {
  if (!isRecord(recovery)) return undefined;
  return {
    ...(recovery.action ? { action: String(recovery.action) } : {}),
    ...(Number.isFinite(Number(recovery.attempts)) ? { attempts: Number(recovery.attempts) } : {}),
    ...(recovery.outcome ? { outcome: String(recovery.outcome) } : {}),
    ...(recovery.queryFingerprint ? { queryFingerprint: String(recovery.queryFingerprint) } : {}),
  };
}

function publicTimelineItem(rawItem) {
  const type = SAFE_TIMELINE_TYPES.has(String(rawItem?.type || ""))
    ? String(rawItem.type)
    : "agent-event";
  const item = {
    type,
    ...(Number.isFinite(Number(rawItem?.latencyMs)) ? { latencyMs: Number(rawItem.latencyMs) } : {}),
    ...(rawItem?.citationValidation ? { citationValidation: String(rawItem.citationValidation) } : {}),
    ...(rawItem?.terminalStatus ? { terminalStatus: String(rawItem.terminalStatus) } : {}),
    ...(rawItem?.failureCode ? { failureCode: String(rawItem.failureCode) } : {}),
    ...(rawItem?.stoppedReason ? { stoppedReason: String(rawItem.stoppedReason) } : {}),
    ...(rawItem?.recovery ? { recovery: publicRecovery(rawItem.recovery) } : {}),
  };
  if (SAFE_TOOL_NAMES.has(String(rawItem?.toolName || ""))) {
    item.toolName = String(rawItem.toolName);
  }
  return item;
}

export function buildRuntimeRunSummary({ runId, threadId, actorScope, metrics, mainAgentToolContext, governedAnalysisPlan } = {}) {
  const toolCalls = Array.isArray(mainAgentToolContext?.toolCalls) ? mainAgentToolContext.toolCalls : [];
  const toolEvents = Array.isArray(mainAgentToolContext?.toolEvents) ? mainAgentToolContext.toolEvents : [];
  const recoveries = toolEvents
    .filter((event) => event?.type === "tool-recovery" && event?.recovery)
    .map((event) => event.recovery);
  const stoppedReason = String(mainAgentToolContext?.stoppedReason || "");
  const evidenceGate = metrics?.evidenceGate || {};
  const businessRuleCodes = unique([
    ...(governedAnalysisPlan?.ruleEffects || []).map((effect) => effect?.code),
    ...(governedAnalysisPlan?.ruleCodes || []),
  ]);
  return {
    schemaVersion: "1.0",
    runId: String(runId || ""),
    threadId: String(threadId || ""),
    actorScopeHash: String(actorScope?.scopeHash || ""),
    intent: String(metrics?.toolRouting?.intent || "general"),
    outcome: outcomeFromStoppedReason(stoppedReason),
    evidenceStatus: String(evidenceGate.status || "not_required"),
    toolNames: unique(toolCalls.map((toolCall) => toolCall?.function?.name)),
    toolOutcomes: unique(toolEvents.filter((event) => /tool-(?:output|blocked)/.test(String(event?.type))).map((event) => event.type)),
    recoveryOutcomes: unique(recoveries.map((recovery) => recovery?.outcome)),
    sourceRevisionIds: unique(evidenceGate.sourceRevisionIds),
    citationValidation: "pending",
    ...(businessRuleCodes.length ? { businessRuleCodes } : {}),
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(recoveries.some((recovery) => recovery?.action === "deny") ? { failureCode: "TOOL_ACCESS_DENIED" } : {}),
  };
}

export function summarizeRuns({ summaries = [], events = [] } = {}) {
  const streamByRun = new Map();
  for (const event of events) {
    if (!event?.runId) continue;
    if (event.type === "agent-stream-completed") {
      streamByRun.set(String(event.runId), event);
    }
  }
  const byOutcome = {};
  const byEvidenceStatus = {};
  const citationValidation = {};
  const recoveryOutcomes = {};
  const failures = {};
  const latencies = [];
  const runs = summaries.map((rawSummary) => {
    const stream = streamByRun.get(String(rawSummary?.runId || ""));
    const citation = String(stream?.citationValidation || rawSummary?.citationValidation || "pending");
    const latencyMs = Number(stream?.latencyMs);
    const outcome = operationalOutcome(rawSummary, stream);
    const failureCode = String(stream?.failureCode || rawSummary?.failureCode || "");
    const run = publicRun(rawSummary, stream);
    increment(byOutcome, outcome);
    increment(byEvidenceStatus, String(rawSummary?.evidenceStatus || "not_required"));
    increment(citationValidation, citation);
    for (const outcome of rawSummary?.recoveryOutcomes || []) increment(recoveryOutcomes, String(outcome));
    increment(failures, failureCode);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) latencies.push(latencyMs);
    return run;
  });
  const topFailureCodes = Object.entries(failures)
    .map(([code, countValue]) => ({ code, count: Number(countValue) }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  return {
    totalRuns: runs.length,
    byOutcome: count(byOutcome),
    byEvidenceStatus: count(byEvidenceStatus),
    latency: { p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) },
    citationValidation: count(citationValidation),
    topFailureCodes,
    recoveryOutcomes: count(recoveryOutcomes),
    runs,
  };
}

async function readJsonLines(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadAgentOperations({ rootDir, operation = "summary", runId = "" } = {}) {
  const base = String(rootDir || "").trim();
  if (!base) throw new Error("AGENT_OPERATIONS_ROOT_REQUIRED");
  const [summaries, events, toolAudits] = await Promise.all([
    readJsonLines(path.join(base, "run-summaries.jsonl")),
    readJsonLines(path.join(base, "run-events.jsonl")),
    readJsonLines(path.join(base, "tool-calls.jsonl")),
  ]);
  const summary = summarizeRuns({ summaries, events });
  if (operation === "summary") return summary;
  const normalizedRunId = String(runId || "").trim();
  const sourceSummary = summaries.find((item) => opaqueRunRef(item?.runId) === normalizedRunId);
  const run = summary.runs.find((item) => item.runRef === normalizedRunId);
  if (!run || !sourceSummary) return null;
  const timeline = [
    ...events.filter((event) => String(event?.runId || "") === String(sourceSummary.runId || "")),
    ...toolAudits.filter((audit) => String(audit?.runId || "") === String(sourceSummary.runId || "")),
  ].map((item) => publicTimelineItem(item));
  return { run, timeline };
}

function opaqueRunRef(runId) {
  return `run-${createHash("sha256").update(String(runId || ""), "utf8").digest("hex").slice(0, 16)}`;
}

function publicRun(rawSummary, stream) {
  const latencyMs = Number(stream?.latencyMs);
  const outcome = operationalOutcome(rawSummary, stream);
  const failureCode = String(stream?.failureCode || rawSummary?.failureCode || "");
  return {
    runRef: opaqueRunRef(rawSummary?.runId),
    intent: String(rawSummary?.intent || "general"),
    outcome,
    evidenceStatus: String(rawSummary?.evidenceStatus || "not_required"),
    citationValidation: String(stream?.citationValidation || rawSummary?.citationValidation || "pending"),
    toolNames: unique(rawSummary?.toolNames).filter((name) => SAFE_TOOL_NAMES.has(name)),
    ...(Number.isFinite(latencyMs) && latencyMs >= 0 ? { latencyMs } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(Array.isArray(rawSummary?.businessRuleCodes) ? { businessRuleCodes: unique(rawSummary.businessRuleCodes) } : {}),
  };
}
