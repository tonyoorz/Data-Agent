import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import path from "node:path";

import { isOidcScopedActor } from "../agentAuth.mjs";
import { resolveAiAnalyticsContext } from "../aiAnalyticsContext.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "../aiContext.mjs";
import { buildCitationContractContext } from "../answerValidator.mjs";
import { requestCompanyChatCompletion } from "../companyChat.mjs";
import { isAnalyticsActorScopeConfigured } from "../internalActorScope.mjs";
import { buildDataAccessUnavailableResponse, classifyDirectMainAgentIntent } from "../mainAgentDirectIntent.mjs";
import {
  buildSemanticContinuationContext,
  evaluateSemanticEvidence,
  formatSemanticEvidenceGate,
} from "../mainAgentEvidence.mjs";
import { buildRuntimeRunSummary } from "./runSummary.mjs";
import { createTokenBudgetGuard } from "./tokenBudgetGuard.mjs";
import { createSubagentFanout } from "./subagentFanout.mjs";
import { buildDataHealth } from "./dataQualityNote.mjs";
import { buildDynamicPlanningContext, withDataQualityFootnote } from "./dynamicContext.mjs";
import { safeAppendSessionEvent } from "./sessionEventLogging.mjs";
import {
  buildDefectReporterAggregateToolCall,
  buildDefectReporterAliasLookupToolCall,
  buildDefectReporterClarificationToolCall,
  buildDefectReporterLookupToolCall,
  buildEmptyDiagnosisToolCall,
  buildSelectedToolsetContext,
  buildToolPlanningContext,
  executeMainAgentPlannedToolCall,
  hasEmptyAnalyticsResult,
  hasPlannedDiagnosis,
  privateAdapterToolCall,
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../mainAgentToolPlanning.mjs";
import { isToolAllowed } from "../mainAgentToolRegistry.mjs";
import { primitiveForLegacyTool, toPrimitiveToolCall } from "../mainAgentPrimitives.mjs";
import {
  buildCatalogBackedAnalyticsRetry,
  buildGovernedSemanticPlanRetry,
  completeCatalogBackedAnalyticsRetry,
} from "../mainAgentToolRecovery.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";
import { validateGovernedAnalysisPlan } from "../ontology/analysisPlanner.mjs";
import { fingerprintQueryPlanSteps, validatePlan } from "../ontology/queryPlanner.mjs";

const SUPPORTED_RUNTIME_MODES = new Set(["langgraph"]);

const overwrite = (_left, right) => right;
const append = (left, right) => [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];

const ChatState = Annotation.Root({
  body: Annotation({ reducer: overwrite, default: () => ({}) }),
  toolDependencies: Annotation({ reducer: overwrite, default: () => ({}) }),
  runId: Annotation({ reducer: overwrite, default: () => "" }),
  threadId: Annotation({ reducer: overwrite, default: () => "" }),
  actorScope: Annotation({ reducer: overwrite, default: () => ({}) }),
  queryText: Annotation({ reducer: overwrite, default: () => "" }),
  model: Annotation({ reducer: overwrite, default: () => "" }),
  analyticsContext: Annotation({ reducer: overwrite, default: () => null }),
  defectContext: Annotation({ reducer: overwrite, default: () => null }),
  toolRouting: Annotation({ reducer: overwrite, default: () => null }),
  plannedToolCalls: Annotation({ reducer: overwrite, default: () => [] }),
  plannedToolCallSource: Annotation({ reducer: overwrite, default: () => "" }),
  toolExecutionMode: Annotation({ reducer: overwrite, default: () => "model" }),
  toolStepIndex: Annotation({ reducer: overwrite, default: () => 0 }),
  stoppedReason: Annotation({ reducer: overwrite, default: () => "" }),
  directResponse: Annotation({ reducer: overwrite, default: () => null }),
  toolCalls: Annotation({ reducer: append, default: () => [] }),
  toolMessages: Annotation({ reducer: append, default: () => [] }),
  toolConversationMessages: Annotation({ reducer: append, default: () => [] }),
  toolEvents: Annotation({ reducer: append, default: () => [] }),
  toolEvidence: Annotation({ reducer: append, default: () => [] }),
  toolResultTexts: Annotation({ reducer: append, default: () => [] }),
  turnToolCallStart: Annotation({ reducer: overwrite, default: () => 0 }),
  turnToolMessageStart: Annotation({ reducer: overwrite, default: () => 0 }),
  turnToolConversationStart: Annotation({ reducer: overwrite, default: () => 0 }),
  turnToolEventStart: Annotation({ reducer: overwrite, default: () => 0 }),
  turnToolEvidenceStart: Annotation({ reducer: overwrite, default: () => 0 }),
  turnToolResultStart: Annotation({ reducer: overwrite, default: () => 0 }),
  mainAgentToolContext: Annotation({ reducer: overwrite, default: () => null }),
  baseContext: Annotation({ reducer: overwrite, default: () => "" }),
  context: Annotation({ reducer: overwrite, default: () => "" }),
  finalMessages: Annotation({ reducer: overwrite, default: () => [] }),
  prefaceEvents: Annotation({ reducer: overwrite, default: () => [] }),
  metrics: Annotation({ reducer: overwrite, default: () => ({}) }),
  runtimeEvents: Annotation({ reducer: append, default: () => [] }),
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeThreadId(body, now) {
  const explicit = [body?.threadId, body?.conversationId, body?.sessionId].find(isNonEmptyString);
  if (explicit) {
    return String(explicit).trim();
  }
  return `chat-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRunId(body, now) {
  if (isNonEmptyString(body?.runId)) {
    return String(body.runId).trim();
  }
  return `run-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeActorScope(body) {
  const actor = body?.actor && typeof body.actor === "object" ? body.actor : body?.actorScope && typeof body.actorScope === "object" ? body.actorScope : {};
  const rawScopes = actor.scopes && typeof actor.scopes === "object" ? actor.scopes : {};
  const scopes = {};
  for (const key of ["workspaceIds", "projectIds", "teamIds", "allowedObjectTypes", "allowedPropertyIds", "rowPolicyIds", "sensitiveFieldPolicyIds"]) {
    const values = stringList(rawScopes[key]);
    if (values.length) {
      scopes[key] = values;
    }
  }
  return {
    actorId: String(actor.actorId || body?.userId || body?.user?.id || "").trim(),
    scopeHash: String(actor.scopeHash || "").trim(),
    ...(Object.keys(scopes).length ? { scopes } : {}),
  };
}

function hasActorScope(actorScope) {
  return Boolean(actorScope?.actorId || actorScope?.scopeHash || Object.keys(actorScope?.scopes || {}).length);
}

function cloneEventForObserver(event) {
  if (!event || typeof event !== "object") return event;
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(event);
  return JSON.parse(JSON.stringify(event));
}

function emit(config, event) {
  config?.configurable?.onEvent?.(cloneEventForObserver(event));
  return event;
}

function createRunnableSignal() {
  if (typeof AbortController === "undefined") {
    return undefined;
  }
  const controller = new AbortController();
  if (typeof controller.signal.throwIfAborted !== "function") {
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value() {
        if (this.aborted) {
          throw new Error("LangGraph run aborted");
        }
      },
    });
  }
  return controller.signal;
}

function createDefaultOntologyRegistry() {
  try {
    return createOntologyRegistry();
  } catch {
    return null;
  }
}

function ensureAbortSignalCompatibility() {
  const prototype = globalThis.AbortSignal?.prototype;
  if (!prototype || typeof prototype.throwIfAborted === "function") {
    return;
  }
  Object.defineProperty(prototype, "throwIfAborted", {
    value() {
      if (this.aborted) {
        throw new Error("LangGraph run aborted");
      }
    },
  });
}

function mergeContext(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(toolCall) {
  const toolName = String(toolCall?.function?.name || "").trim();
  if (!toolName) {
    return "";
  }
  const rawArguments = toolCall?.function?.arguments;
  if (typeof rawArguments === "string") {
    try {
      return `${toolName}:${canonicalJson(JSON.parse(rawArguments))}`;
    } catch {
      return `${toolName}:${JSON.stringify(rawArguments)}`;
    }
  }
  return `${toolName}:${canonicalJson(rawArguments ?? {})}`;
}

function removeRepeatedToolCalls(plannedToolCalls, priorToolCalls) {
  const signatures = new Set((Array.isArray(priorToolCalls) ? priorToolCalls : [])
    .map(toolCallSignature)
    .filter(Boolean));
  let removedDuplicate = false;
  const uniqueToolCalls = [];

  for (const toolCall of Array.isArray(plannedToolCalls) ? plannedToolCalls : []) {
    const signature = toolCallSignature(toolCall);
    if (signature && signatures.has(signature)) {
      removedDuplicate = true;
      continue;
    }
    if (signature) {
      signatures.add(signature);
    }
    uniqueToolCalls.push(toolCall);
  }

  return { uniqueToolCalls, removedDuplicate };
}

function parseToolCallArguments(toolCall) {
  const rawArguments = toolCall?.function?.arguments;
  if (isRecord(rawArguments)) {
    return rawArguments;
  }
  try {
    const parsed = JSON.parse(String(rawArguments || "{}"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isCompletedTopIssueGrowthRank(toolCall, result) {
  const adapterCall = privateAdapterToolCall(toolCall);
  if (adapterCall?.function?.name !== "query_analytics" || hasEmptyAnalyticsResult(toolCall, result)) {
    return false;
  }
  let payload = {};
  try {
    payload = JSON.parse(String(result?.toolMessage?.content || "{}"));
  } catch {
    return false;
  }
  if (payload?.ok !== true) {
    return false;
  }

  const query = parseToolCallArguments(adapterCall);
  const dimensions = Array.isArray(query.dimensions) ? query.dimensions : [];
  const derivedMetrics = Array.isArray(query.derived_metrics) ? query.derived_metrics : [];
  const orderBy = Array.isArray(query.order_by) ? query.order_by : [];
  const ordersByDeltaDescending = orderBy.some((order) => order?.field === "delta" && order?.direction === "desc");
  return query.dataset === "defects"
    && query.intent === "rank"
    && dimensions.includes("business_module")
    && derivedMetrics.includes("delta")
    && derivedMetrics.includes("growth_pct")
    && ordersByDeltaDescending;
}

function buildReadySemanticPlanToolCalls({ analyticsContext, actorScope, selectedToolset } = {}) {
  const analysisPlan = governedAnalysisAuditFromContext(analyticsContext);
  const queryPlan = analyticsContext?.queryPlan;
  const actorScopeHash = String(actorScope?.scopeHash || "");
  if (
    analysisPlan?.status !== "ready"
    || queryPlan?.status !== "valid"
    || !actorScopeHash
    || String(queryPlan?.actorScopeHash || "") !== actorScopeHash
    || String(analysisPlan?.sourcePlanId || "") !== String(queryPlan?.planId || "")
  ) {
    return [];
  }

  const semanticSteps = (Array.isArray(queryPlan?.steps) ? queryPlan.steps : [])
    .filter((step) => isRecord(step?.canonicalArgs)
      && isRecord(step?.canonicalArgs?.query)
      && ((step?.operation === "semantic_metric_query" && step?.toolName === "query_semantic_metrics")
        || (step?.operation === "semantic_record_query" && step?.toolName === "query_semantic_records")
        || (step?.operation === "traceability_query" && step?.toolName === "query_traceability")));
  if (semanticSteps.length !== 1) {
    return [];
  }

  const step = semanticSteps[0];
  if (!isToolAllowed(primitiveForLegacyTool(step.toolName), selectedToolset)) {
    return [];
  }
  const stepId = String(step?.stepId || "").trim();
  if (!stepId) {
    return [];
  }
  if (step.toolName === "query_semantic_records") {
    return [{
      id: `${queryPlan.planId}-${stepId}`,
      type: "function",
      function: { name: "records", arguments: JSON.stringify({ operation: "semantic", input: { plan_ref: queryPlan.planId } }) },
    }];
  }
  if (step.toolName === "query_traceability") {
    return [{
      id: `${queryPlan.planId}-${stepId}`,
      type: "function",
      function: { name: "trace", arguments: JSON.stringify({ plan_ref: queryPlan.planId }) },
    }];
  }
  return [{
    id: `${queryPlan.planId}-${stepId}`,
    type: "function",
    function: {
      name: "analyze",
      arguments: JSON.stringify({ operation: "semantic_metrics", input: { plan_ref: queryPlan.planId } }),
    },
  }];
}

function toolAuditsFromContext(mainAgentToolContext, { runId, threadId, actorScope }) {
  const byId = new Map();
  for (const event of mainAgentToolContext?.toolEvents || []) {
    const toolCallId = String(event?.toolCallId || "");
    if (!toolCallId) {
      continue;
    }
    const current = byId.get(toolCallId) || { runId, threadId, actorScope, toolCallId, toolName: String(event?.toolName || "") };
    if (event.type === "tool-input-available") {
      current.input = event.input;
    }
    if (event.type === "tool-output-available") {
      current.outputSummary = event.outputSummary;
    }
    if (event.type === "tool-recovery") {
      current.recovery = event.recovery;
      delete current.input;
    }
    if (event.toolName) {
      current.toolName = String(event.toolName);
    }
    byId.set(toolCallId, current);
  }
  return [...byId.values()].map((audit) => {
    if (audit.recovery) {
      delete audit.input;
    }
    return audit;
  });
}

function toolLifecycleEventsFromContext(mainAgentToolContext, { runId, threadId }) {
  const events = [];
  const intent = mainAgentToolContext?.selectedToolset?.intent || "unknown";
  for (const event of mainAgentToolContext?.toolEvents || []) {
    if (event.type === "tool-input-available") {
      events.push({
        runId,
        threadId,
        type: "agent.tool.started",
        toolCallId: String(event.toolCallId || ""),
        toolName: String(event.toolName || ""),
        intent,
      });
    }
    if (event.type === "tool-output-available") {
      events.push({
        runId,
        threadId,
        type: "agent.tool.completed",
        toolCallId: String(event.toolCallId || ""),
        toolName: String(event.toolName || ""),
        intent,
        stoppedReason: "",
      });
    }
    if (event.type === "tool-blocked") {
      events.push({
        runId,
        threadId,
        type: "agent.tool.blocked",
        toolCallId: String(event.toolCallId || ""),
        toolName: String(event.toolName || ""),
        intent,
        stoppedReason: String(event.reason || "tool_not_allowed"),
      });
    }
  }
  return events;
}

function governedAnalysisAuditFromContext(analyticsContext) {
  const candidate = analyticsContext?.analysisPlan || analyticsContext?.shadowObservation?.analysisPlan;
  if (!candidate || typeof candidate !== "object") return null;
  try {
    const plan = validateGovernedAnalysisPlan(candidate);
    return {
      schemaVersion: plan.schemaVersion,
      analysisPlanId: plan.analysisPlanId,
      sourcePlanId: plan.sourcePlanId,
      sourcePlanFingerprint: plan.sourcePlanFingerprint,
      ontologyVersion: plan.ontologyVersion,
      schemaFingerprint: plan.schemaFingerprint,
      status: plan.status,
      operation: plan.operation,
      visualization: plan.visualization,
      maxRows: plan.maxRows,
      guardrails: [...plan.guardrails],
      ...(Array.isArray(plan.ruleCodes) ? { ruleCodes: [...plan.ruleCodes] } : {}),
      ...(Array.isArray(plan.ruleEffects) ? { ruleEffects: [...plan.ruleEffects] } : {}),
    };
  } catch {
    return null;
  }
}

async function persistRuntimeState(runtimeStore, state) {
  if (!runtimeStore) {
    return;
  }
  const runId = state.runId || "";
  const threadId = state.threadId || "";
  const actorScope = state.actorScope || {};
  const governedAnalysisPlan = governedAnalysisAuditFromContext(state.analyticsContext);
  for (const event of state.runtimeEvents || []) {
    await runtimeStore.appendRunEvent({ ...event, runId, threadId, actorScope });
  }
  for (const audit of toolAuditsFromContext(state.mainAgentToolContext, { runId, threadId, actorScope })) {
    await runtimeStore.appendToolAudit(audit);
  }
  if (typeof runtimeStore.appendRunSummary === "function") {
    await runtimeStore.appendRunSummary(buildRuntimeRunSummary({
      runId,
      threadId,
      actorScope,
      metrics: state.metrics,
      mainAgentToolContext: state.mainAgentToolContext,
      governedAnalysisPlan,
    }));
  }
  await runtimeStore.writeThreadCheckpoint({
    runId,
    threadId,
    actorScope,
    checkpoint: {
      node: "finalize",
      queryText: state.queryText || "",
      metrics: state.metrics || {},
      runtimeEvents: state.runtimeEvents || [],
      ...(governedAnalysisPlan ? { governedAnalysisPlan } : {}),
    },
  });
}

function runtimeErrorPayload(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "Unknown runtime error"),
    stack: String(error?.stack || ""),
  };
}

async function persistRuntimeFailure(runtimeStore, { runId, threadId, actorScope, queryText, error }) {
  if (!runtimeStore) return;
  await runtimeStore.appendRunEvent({
    runId,
    threadId,
    actorScope,
    queryText,
    type: "agent-runtime-failed",
    error: runtimeErrorPayload(error),
  });
  if (typeof runtimeStore.appendRunSummary === "function") {
    await runtimeStore.appendRunSummary({
      schemaVersion: "1.0",
      runId,
      threadId,
      actorScopeHash: String(actorScope?.scopeHash || ""),
      intent: "unknown",
      outcome: "failed",
      evidenceStatus: "not_required",
      toolNames: [],
      toolOutcomes: [],
      recoveryOutcomes: [],
      sourceRevisionIds: [],
      citationValidation: "pending",
      failureCode: "AGENT_RUNTIME_FAILED",
    });
  }
}

// Write-intent primitives that must clear human approval before execution.
// Current registered primitives are read-only by design; commit/mutate-style
// names activate the gate the moment such a tool is registered.
const WRITE_INTENT_TOOL_NAMES = new Set([
  "commit_testcase",
  "commit_octane_workitem",
  "write_octane_workitem",
  "update_octane_workitem",
  "delete_octane_workitem",
]);

function isWriteIntentToolCall(toolCall) {
  return WRITE_INTENT_TOOL_NAMES.has(String(toolCall?.function?.name || "").trim());
}

function planningRuntimeDate(value) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(value);
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}

function estimateTokensForText(text) {
  // CJK-heavy chat traffic: ~1 token per 1.6 chars is a conservative lower bound.
  return Math.ceil(String(text || "").length / 1.6);
}

async function datasetHealthFromRegistry(registry, options = {}) {
  if (!registry?.bundle?.sources) return null;
  const { stat } = await import("node:fs/promises");
  const byDatabase = new Map();
  for (const source of registry.bundle.sources) {
    if (!source || source.system === "artifact" || !source.database) continue;
    const key = String(source.database);
    const sloMinutes = Math.max(1, Number(source.freshnessSloMinutes || 1440));
    const current = byDatabase.get(key);
    if (!current || sloMinutes < current.sloMinutes) {
      byDatabase.set(key, { database: key, sloMinutes });
    }
  }
  const datasets = [];
  for (const { database, sloMinutes } of byDatabase.values()) {
    try {
      const info = await stat(path.resolve(process.cwd(), database));
      datasets.push({
        name: path.basename(database),
        lastRefreshedAt: info.mtime.toISOString(),
        expectedFrequencyHours: Math.max(1, Math.round(sloMinutes / 60)),
      });
    } catch {
      // Source DB missing locally: freshness unknown, not a quality violation.
    }
  }
  if (!datasets.length) return null;
  return buildDataHealth({ datasets, now: options.now });
}

export function resolveAgentRuntimeMode(env = process.env) {
  const raw = String(env?.VIZION_AGENT_RUNTIME || "").trim().toLowerCase();
  if (!raw) return "langgraph";
  return SUPPORTED_RUNTIME_MODES.has(raw) ? raw : "langgraph";
}

function compactToolRouting(toolRouting) {
  const selectedToolset = toolRouting?.selectedToolset || {};
  return {
    shouldUseTools: Boolean(toolRouting?.shouldUseTools),
    intent: selectedToolset.intent || "general",
    confidence: selectedToolset.confidence || 0,
    reason: selectedToolset.reason || "unknown",
    requiredSlots: Array.isArray(selectedToolset.requiredSlots) ? selectedToolset.requiredSlots : [],
    policyHints: Array.isArray(selectedToolset.policyHints) ? selectedToolset.policyHints : [],
    toolNames: Array.isArray(selectedToolset.toolNames) ? selectedToolset.toolNames : [],
  };
}

function buildMainAgentToolContextFromState(state) {
  const toolCalls = (state.toolCalls || []).slice(Number(state.turnToolCallStart || 0));
  const toolMessages = (state.toolMessages || []).slice(Number(state.turnToolMessageStart || 0));
  const toolConversationMessages = (state.toolConversationMessages || []).slice(Number(state.turnToolConversationStart || 0));
  const toolEvents = (state.toolEvents || []).slice(Number(state.turnToolEventStart || 0));
  const evidence = (state.toolEvidence || []).slice(Number(state.turnToolEvidenceStart || 0));
  const toolResultTexts = (state.toolResultTexts || []).slice(Number(state.turnToolResultStart || 0));
  return {
    contextText: toolResultTexts.filter(Boolean).join("\n\n"),
    toolCalls,
    toolMessages,
    toolConversationMessages,
    toolEvents,
    evidence,
    evidenceGate: evaluateSemanticEvidence(evidence),
    selectedToolset: state.toolRouting?.selectedToolset,
    stoppedReason: state.stoppedReason || "no_tool_calls",
  };
}

function resolveDeterministicQueryPlan({ analyticsContext, actorScope, selectedToolset }) {
  const candidate = analyticsContext?.semanticPlan;
  if (!candidate || typeof candidate !== "object") return null;
  try {
    const plan = validatePlan(candidate);
    const toolNames = new Set(selectedToolset?.toolNames || []);
    if (plan.status !== "valid" || plan.actorScopeHash !== String(actorScope?.scopeHash || "")) return null;
    if (plan.executionFingerprint !== fingerprintQueryPlanSteps(plan.steps)) return null;
    if (!plan.steps.length || !plan.steps.every((step) => step.riskLevel === "R0" && toolNames.has(primitiveForLegacyTool(step.toolName)))) return null;
    return plan;
  } catch {
    return null;
  }
}

function canonicalToolCalls(plan) {
  return plan.steps.map((step) => {
    const publicCall = toPrimitiveToolCall({
      id: `${plan.planId}:${step.stepId}`,
      type: "function",
      function: { name: step.toolName, arguments: JSON.stringify(step.canonicalArgs) },
    });
    if (step.toolName === "query_semantic_records") {
      return {
        ...publicCall,
        function: { ...publicCall.function, arguments: JSON.stringify({ operation: "semantic", input: { plan_ref: plan.planId } }) },
      };
    }
    if (step.toolName === "query_traceability") {
      return {
        ...publicCall,
        function: { ...publicCall.function, arguments: JSON.stringify({ plan_ref: plan.planId }) },
      };
    }
    if (step.toolName !== "query_semantic_metrics") return publicCall;
    return {
      ...publicCall,
      function: {
        ...publicCall.function,
        arguments: JSON.stringify({ operation: "semantic_metrics", input: { plan_ref: plan.planId } }),
      },
    };
  });
}

export function createLangGraphChatRuntime({
  resolveAnalyticsContext = resolveAiAnalyticsContext,
  resolveDefectContext = resolveAiDefectContext,
  ontologyRegistry = createDefaultOntologyRegistry(),
  shouldPlanTools = shouldPlanMainAgentTools,
  requestToolCompletion = requestCompanyChatCompletion,
  executeToolCall,
  maxToolSteps = 4,
  checkpointer = new MemorySaver(),
  runtimeStore = null,
  sessionEventLog = null,
  createBudgetGuard = createTokenBudgetGuard,
  approvalFlow = null,
  semanticCache = null,
  feedbackLoop = null,
  subagentFanout = createSubagentFanout(),
  dynamicPlanningEnabled = true,
  dataQualityFootnotesEnabled = true,
  now = () => new Date(),
} = {}) {
  ensureAbortSignalCompatibility();

  function budgetGuardFor(config) {
    return config?.configurable?.tokenBudgetGuard || null;
  }

  function planCacheKey(plan, actorScope) {
    return `${String(plan?.planId || "")}:${String(actorScope?.scopeHash || "")}`;
  }

  function isApprovedToolCall(approved, toolCall) {
    if (!approved || !toolCall) return false;
    if (String(approved.id || "") && String(approved.id || "") === String(toolCall.id || "")) return true;
    return String(approved.name || "") === String(toolCall?.function?.name || "")
      && canonicalJson(approved.arguments || {}) === canonicalJson(parseToolCallArguments(toolCall));
  }

  async function initialize(state, config) {
    const body = state.body && typeof state.body === "object" ? state.body : {};
    const runId = isNonEmptyString(state.runId) ? String(state.runId).trim() : normalizeRunId(body, now);
    const threadId = isNonEmptyString(state.threadId) ? String(state.threadId).trim() : normalizeThreadId(body, now);
    const actorScope = normalizeActorScope(body);
    const queryText = extractLatestUserQuery(body?.messages);
    const event = emit(config, {
      type: "agent-runtime-started",
      runtime: "langgraph",
      runId,
      threadId,
      queryPreview: queryText.slice(0, 120),
    });
    if (sessionEventLog) {
      const priorEvents = await sessionEventLog.read(threadId).catch(() => []);
      if (!priorEvents.length) {
        await safeAppendSessionEvent(sessionEventLog, { type: "session/start", sessionId: threadId, payload: { runId, actorId: actorScope.actorId || "" } });
      }
      await safeAppendSessionEvent(sessionEventLog, { type: "turn/start", sessionId: threadId, payload: { runId, queryText } });
      await safeAppendSessionEvent(sessionEventLog, { type: "user/message", sessionId: threadId, payload: { content: queryText, runId } });
    }
    return {
      body,
      runId,
      threadId,
      actorScope,
      queryText,
      model: String(body?.model || ""),
      plannedToolCalls: [],
      toolExecutionMode: "model",
      toolStepIndex: 0,
      stoppedReason: "",
      turnToolCallStart: (state.toolCalls || []).length,
      turnToolMessageStart: (state.toolMessages || []).length,
      turnToolConversationStart: (state.toolConversationMessages || []).length,
      turnToolEventStart: (state.toolEvents || []).length,
      turnToolEvidenceStart: (state.toolEvidence || []).length,
      turnToolResultStart: (state.toolResultTexts || []).length,
      runtimeEvents: [event],
    };
  }

  async function resolveContext(state, config) {
    const body = state.body || {};
    if (classifyDirectMainAgentIntent(state.queryText || extractLatestUserQuery(body?.messages))) {
      return {
        analyticsContext: null,
        defectContext: null,
        baseContext: "",
        runtimeEvents: [],
      };
    }
    let analyticsContext = null;
    let defectContext = null;
    const events = [];

    if (body?.useAnalyticsContext === true) {
      if (!isAnalyticsActorScopeConfigured(state.actorScope)) {
        analyticsContext = {
          contextText: "# Governed data access\nStatus: BLOCKED\nReason: a server-owned workspace, team, or project scope and allowed object types are required before data access.",
          skipDefectContext: true,
        };
        events.push(emit(config, { type: "analytics-context-blocked", threadId: state.threadId }));
      } else {
        events.push(emit(config, { type: "analytics-context-started", threadId: state.threadId }));
        const priorSemanticFrame = state.analyticsContext?.semanticFrame ?? null;
        analyticsContext = await resolveAnalyticsContext({
          messages: body?.messages,
          actor: state.actorScope,
          ...(ontologyRegistry ? { ontologyRegistry } : {}),
          ...(priorSemanticFrame ? { priorSemanticFrame } : {}),
        });
        const governedAnalysisPlan = governedAnalysisAuditFromContext(analyticsContext);
        if (governedAnalysisPlan) {
          events.push(emit(config, {
            type: "governed-analysis-plan-ready",
            threadId: state.threadId,
            analysisPlan: governedAnalysisPlan,
          }));
        }
      }
    }

    if (body?.useDefectContext === true && !analyticsContext?.skipDefectContext && !isOidcScopedActor(state.actorScope)) {
      events.push(emit(config, { type: "defect-context-started", threadId: state.threadId }));
      defectContext = await resolveDefectContext({
        messages: body?.messages,
        topK: 5,
        ...(state.toolDependencies || {}),
      });
    }

    const baseContext = mergeContext(body?.context, analyticsContext?.contextText, defectContext?.contextText);
    return {
      analyticsContext,
      defectContext,
      baseContext,
      runtimeEvents: events,
    };
  }

  async function routeTools(state, config) {
    const body = state.body || {};
    const selectedToolset = selectMainAgentToolset(body?.messages, state.toolCalls);
    const actorScopeConfigured = isAnalyticsActorScopeConfigured(state.actorScope);
    const needsDataTools = body?.useAnalyticsContext === true
      && (shouldPlanTools(body?.messages) || selectedToolset.policyHints?.includes("resolve_defect_reporter_before_aggregate"));
    const directResponse = classifyDirectMainAgentIntent(state.queryText || extractLatestUserQuery(body?.messages))
      || (!actorScopeConfigured && needsDataTools ? buildDataAccessUnavailableResponse() : null);
    const governedPlanDenied = state.analyticsContext?.analysisPlan?.status === "denied";
    const shouldUseTools =
      !directResponse &&
      actorScopeConfigured &&
      !governedPlanDenied &&
      body?.useAnalyticsContext === true &&
      !state.analyticsContext?.skipDefectContext &&
      (shouldPlanTools(body?.messages) || selectedToolset.policyHints?.includes("resolve_defect_reporter_before_aggregate"));
    const toolRouting = { shouldUseTools, selectedToolset };
    const compact = compactToolRouting(toolRouting);
    const event = emit(config, {
      type: "tool-routing-completed",
      threadId: state.threadId,
      shouldUseTools: compact.shouldUseTools,
      intent: directResponse?.intent || compact.intent,
      toolNames: compact.toolNames,
    });
    return {
      directResponse,
      toolRouting,
      runtimeEvents: [event],
    };
  }

  function buildToolDependencies(state) {
    const toolDependencies = { ...(state.toolDependencies || {}) };
    if (hasActorScope(state.actorScope)) {
      toolDependencies.actor = state.actorScope;
    }
    const governedQueryPlan = state.analyticsContext?.queryPlan?.status === "valid"
      ? state.analyticsContext.queryPlan
      : state.analyticsContext?.semanticPlan?.status === "valid"
        ? state.analyticsContext.semanticPlan
        : null;
    if (governedQueryPlan) {
      toolDependencies.governedQueryPlan = governedQueryPlan;
    }
    return toolDependencies;
  }

  async function planToolCalls(state, config) {
    const body = state.body || {};
    const selectedToolset = state.toolRouting?.selectedToolset || selectMainAgentToolset(body?.messages);
    const events = Number(state.toolStepIndex || 0) === 0
      ? [emit(config, { type: "tool-planning-started", threadId: state.threadId })]
      : [];
    const defectReporterLookup = buildDefectReporterLookupToolCall(body?.messages, state.toolCalls);
    if (defectReporterLookup) {
      return {
        plannedToolCalls: [defectReporterLookup],
        plannedToolCallSource: "defect_reporter_lookup",
        toolExecutionMode: "model",
        stoppedReason: "",
        runtimeEvents: events,
      };
    }
    const defectReporterAliasLookup = buildDefectReporterAliasLookupToolCall({
      messages: body?.messages,
      toolMessages: state.toolMessages,
      priorToolCalls: state.toolCalls,
    });
    if (defectReporterAliasLookup) {
      return {
        plannedToolCalls: [defectReporterAliasLookup],
        plannedToolCallSource: "defect_reporter_alias_lookup",
        toolExecutionMode: "model",
        stoppedReason: "",
        runtimeEvents: events,
      };
    }
    const defectReporterAggregate = buildDefectReporterAggregateToolCall({
      messages: body?.messages,
      toolMessages: state.toolMessages,
      priorToolCalls: state.toolCalls,
      now: now(),
    });
    if (defectReporterAggregate) {
      return {
        plannedToolCalls: [defectReporterAggregate],
        plannedToolCallSource: "defect_reporter_aggregate",
        toolExecutionMode: "deterministic",
        stoppedReason: "",
        runtimeEvents: events,
      };
    }
    const defectReporterClarification = buildDefectReporterClarificationToolCall({
      messages: body?.messages,
      toolMessages: state.toolMessages,
      priorToolCalls: state.toolCalls,
    });
    if (defectReporterClarification) {
      return {
        plannedToolCalls: [defectReporterClarification],
        plannedToolCallSource: "defect_reporter_clarification",
        toolExecutionMode: "model",
        stoppedReason: "",
        runtimeEvents: events,
      };
    }
    // Semantic cache read: reuse a verified governed result for the same plan+scope.
    if (semanticCache && Number(state.toolStepIndex || 0) === 0) {
      const planForCache = state.analyticsContext?.queryPlan?.status === "valid"
        ? state.analyticsContext.queryPlan
        : state.analyticsContext?.semanticPlan?.status === "valid"
          ? state.analyticsContext.semanticPlan
          : null;
      if (planForCache) {
        const cached = await semanticCache.get(planCacheKey(planForCache, state.actorScope)).catch(() => null);
        if (cached?.contextText) {
          events.push(emit(config, { type: "semantic-cache-hit", threadId: state.threadId, via: cached._cache?.via || "exact" }));
          return {
            plannedToolCalls: [],
            plannedToolCallSource: "semantic_cache",
            stoppedReason: "semantic_cache_hit",
            toolExecutionMode: "deterministic",
            toolResultTexts: [cached.contextText],
            runtimeEvents: events,
          };
        }
      }
    }
    const governedPlanToolCalls = buildReadySemanticPlanToolCalls({
      analyticsContext: state.analyticsContext,
      actorScope: state.actorScope,
      selectedToolset,
    });
    if (governedPlanToolCalls.length) {
      return {
        plannedToolCalls: governedPlanToolCalls,
        plannedToolCallSource: "governed_semantic_plan",
        toolExecutionMode: "deterministic",
        stoppedReason: "",
        runtimeEvents: events,
      };
    }
    const deterministicPlan = Number(state.toolStepIndex || 0) === 0
      ? resolveDeterministicQueryPlan({ analyticsContext: state.analyticsContext, actorScope: state.actorScope, selectedToolset })
      : null;
    if (deterministicPlan) {
      const plannedToolCalls = canonicalToolCalls(deterministicPlan);
      events.push(emit(config, {
        type: "deterministic-tool-plan-ready",
        threadId: state.threadId,
        planId: deterministicPlan.planId,
        toolNames: plannedToolCalls.map((toolCall) => toolCall.function.name),
      }));
      return {
        plannedToolCalls,
        plannedToolCallSource: "canonical_query_plan",
        toolExecutionMode: "deterministic",
        stoppedReason: "",
        toolCalls: plannedToolCalls,
        toolConversationMessages: [{ role: "assistant", content: "", tool_calls: plannedToolCalls }],
        runtimeEvents: events,
      };
    }
    const guard = budgetGuardFor(config);
    if (guard && !guard.canAdmitFullStep()) {
      guard.markDegraded("planning_budget_exhausted");
      events.push(emit(config, { type: "budget-exceeded", threadId: state.threadId, at: "planning" }));
      return {
        plannedToolCalls: [],
        plannedToolCallSource: "",
        stoppedReason: "budget_exceeded",
        toolExecutionMode: "model",
        runtimeEvents: events,
      };
    }
    const feedbackHints = [];
    if (feedbackLoop && state.queryText) {
      try {
        const negatives = await feedbackLoop.findSimilarNegatives(state.queryText, { threshold: 0.4, limit: 2 });
        for (const item of negatives) {
          feedbackHints.push(`demote:${item.record.intent}:${item.record.toolNames.join("+")}`);
        }
      } catch {
        // Feedback history is advisory; failures never block planning.
      }
    }
    const planningContext = mergeContext(
      state.baseContext,
      dynamicPlanningEnabled
        ? buildDynamicPlanningContext({
            intent: selectedToolset.intent,
            toolNames: (selectedToolset.tools || []).map((tool) => tool.function?.name).filter(Boolean),
            policyHints: [...(selectedToolset.policyHints || []), ...feedbackHints],
            runtimeDate: planningRuntimeDate(now()),
          })
        : buildToolPlanningContext(now()),
      buildSelectedToolsetContext(selectedToolset),
      buildSemanticContinuationContext(state.toolEvidence || [], state.actorScope),
    );
    const planningResult = await requestToolCompletion({
      messages: [
        ...(Array.isArray(body?.messages) ? body.messages : []),
        ...(state.toolConversationMessages || []).slice(Number(state.turnToolConversationStart || 0)),
      ],
      model: body?.model,
      context: planningContext,
      tools: selectedToolset.tools,
      toolChoice: "auto",
    });
    if (guard) {
      guard.recordStep();
      const usage = planningResult?.usage || planningResult?.tokenUsage;
      if (usage) {
        guard.recordRequest(usage);
      } else {
        guard.recordRequest({ input: estimateTokensForText(planningContext), output: 0 });
      }
    }
    if (sessionEventLog) {
      await safeAppendSessionEvent(sessionEventLog, {
        type: "agent/request",
        sessionId: state.threadId,
        payload: {
          runId: state.runId,
          tokens: guard
            ? { input: guard.snapshot().session.input, output: guard.snapshot().session.output, total: guard.snapshot().session.total }
            : null,
          contextChars: planningContext.length,
          dynamicPlanning: dynamicPlanningEnabled,
        },
      });
    }
    const modelToolCalls = Array.isArray(planningResult.toolCalls) ? planningResult.toolCalls.slice(0, 3) : [];
    const { uniqueToolCalls: plannedToolCalls, removedDuplicate } = removeRepeatedToolCalls(modelToolCalls, state.toolCalls);
    if (!plannedToolCalls.length) {
      return {
        plannedToolCalls: [],
        plannedToolCallSource: "",
        stoppedReason: removedDuplicate ? "duplicate_tool_call" : "no_tool_calls",
        toolExecutionMode: "model",
        runtimeEvents: events,
      };
    }
    return {
      plannedToolCalls,
      plannedToolCallSource: "model",
      toolExecutionMode: "model",
      stoppedReason: "",
      runtimeEvents: events,
    };
  }

  async function executeToolCalls(state, config) {
    const selectedToolset = state.toolRouting?.selectedToolset;
    const toolDependencies = buildToolDependencies(state);
    const plannedToolCalls = Array.isArray(state.plannedToolCalls) ? state.plannedToolCalls : [];
    const toolCalls = [];
    const toolMessages = [];
    const toolConversationMessages = [];
    const toolEvents = [];
    const toolEvidence = [];
    const toolResultTexts = [];
    const allToolCalls = [...(state.toolCalls || [])];
    let stoppedReason = "";
    const guard = budgetGuardFor(config);

    if (guard) {
      if (!guard.canToolStep()) {
        guard.markDegraded("tool_budget_exhausted");
        return {
          plannedToolCalls: [],
          toolStepIndex: Number(state.toolStepIndex || 0),
          stoppedReason: "budget_exceeded",
          runtimeEvents: [emit(config, { type: "budget-exceeded", threadId: state.threadId, at: "tool_execution" })],
        };
      }
      guard.recordToolStep();
    }

    async function executeOne(toolCall, { catalogRecovery = null, deferCatalogStop = false } = {}) {
      toolCalls.push(toolCall);
      toolConversationMessages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
      await safeAppendSessionEvent(sessionEventLog, {
        type: "tool/call",
        sessionId: state.threadId,
        payload: {
          id: String(toolCall?.id || `t${toolCalls.length}`),
          name: String(toolCall?.function?.name || ""),
          arguments: String(toolCall?.function?.arguments || "{}").slice(0, 4000),
        },
      });
      const executed = await executeMainAgentPlannedToolCall({
        toolCall,
        selectedToolset,
        executeToolCall,
        toolDependencies,
      });
      toolMessages.push(executed.result.toolMessage);
      toolConversationMessages.push(executed.result.toolMessage);
      toolEvents.push(...executed.toolEvents);
      if (executed.evidence) {
        toolEvidence.push(executed.evidence);
      }
      if (executed.result.contextText) {
        toolResultTexts.push(executed.result.contextText);
      }
      await safeAppendSessionEvent(sessionEventLog, {
        type: "tool/result",
        sessionId: state.threadId,
        payload: {
          id: String(toolCall?.id || `t${toolCalls.length}`),
          ok: !executed.stoppedReason,
          resultText: String(executed.result?.contextText || executed.result?.toolMessage?.content || "").slice(0, 4000),
        },
      });
      const deferredCatalogStop = deferCatalogStop && executed.recovery?.action === "catalog";
      if (executed.stoppedReason && !deferredCatalogStop) {
        stoppedReason = executed.stoppedReason;
      }
      if (catalogRecovery) {
        toolEvents.push({
          type: "tool-recovery",
          toolCallId: toolCall?.id || "",
          toolName: toolCall?.function?.name || "unknown_tool",
          recovery: completeCatalogBackedAnalyticsRetry({
            recovery: catalogRecovery,
            result: executed.result,
            stoppedReason: executed.stoppedReason,
          }),
        });
      }
      return {
        result: executed.result,
        recovery: executed.recovery,
        stoppedReason: executed.stoppedReason,
        deferredCatalogStop,
      };
    }

    // Approval gate: suspend before executing any write-intent tool call.
    if (approvalFlow) {
      const writeToolCall = plannedToolCalls.find(isWriteIntentToolCall);
      if (writeToolCall) {
        const alreadyApproved = isApprovedToolCall(state.body?._approvedToolCall, writeToolCall);
        if (!alreadyApproved) {
          const request = await approvalFlow.request({
            sessionId: state.threadId,
            kind: "dry_run",
            summary: `execute ${writeToolCall?.function?.name}`,
            toolCall: {
              id: String(writeToolCall?.id || ""),
              name: String(writeToolCall?.function?.name || ""),
              arguments: parseToolCallArguments(writeToolCall),
            },
            handoffState: { runId: state.runId, threadId: state.threadId, toolCall: writeToolCall },
          }).catch(() => null);
          if (request) {
            stoppedReason = "approval_pending";
            const event = emit(config, {
              type: "approval-required",
              threadId: state.threadId,
              approvalId: request.approvalId,
              toolName: String(writeToolCall?.function?.name || ""),
            });
            return {
              plannedToolCalls: [],
              toolStepIndex: Number(state.toolStepIndex || 0),
              stoppedReason,
              runtimeEvents: [event],
              directResponse: {
                intent: "approval_pending",
                content: `该操作（${writeToolCall?.function?.name}）需要人工确认。审批单号：${request.approvalId}。请在确认后携带 approvalDecision 重新发起请求。`,
              },
            };
          }
        }
      }
    }

    // Parallel fan-out for independent governed steps (no dependsOn edges).
    const governedPlan = toolDependencies.governedQueryPlan || null;
    if (subagentFanout
      && Array.isArray(plannedToolCalls)
      && plannedToolCalls.length > 1
      && Array.isArray(governedPlan?.steps)
      && governedPlan.steps.length === plannedToolCalls.length
      && governedPlan.steps.every((step) => Array.isArray(step?.dependsOn) && step.dependsOn.length === 0)) {
      const fanout = subagentFanout || createSubagentFanout({ budgetGuard: guard });
      const perBranch = plannedToolCalls.map((toolCall) => ({ toolCall, executed: null }));
      const fanoutResult = await fanout.run(plannedToolCalls.map((toolCall, index) => ({
        name: `${String(toolCall?.function?.name || "tool")}#${index}`,
        run: async () => {
          perBranch[index].executed = await executeMainAgentPlannedToolCall({
            toolCall,
            selectedToolset,
            executeToolCall,
            toolDependencies,
          });
          return { stoppedReason: executedOf(index).stoppedReason };
        },
      })));
      function executedOf(index) {
        return perBranch[index].executed || { result: {}, toolEvents: [], stoppedReason: "branch_failed" };
      }
      let branchIndex = 0;
      for (const { toolCall } of perBranch) {
        const executed = executedOf(branchIndex);
        toolCalls.push(toolCall);
        toolConversationMessages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
        await safeAppendSessionEvent(sessionEventLog, {
          type: "tool/call",
          sessionId: state.threadId,
          payload: { id: String(toolCall?.id || `t${branchIndex + 1}`), name: String(toolCall?.function?.name || ""), arguments: String(toolCall?.function?.arguments || "{}").slice(0, 4000) },
        });
        if (executed.result?.toolMessage) {
          toolMessages.push(executed.result.toolMessage);
          toolConversationMessages.push(executed.result.toolMessage);
        }
        toolEvents.push(...(executed.toolEvents || []));
        if (executed.evidence) toolEvidence.push(executed.evidence);
        if (executed.result?.contextText) toolResultTexts.push(executed.result.contextText);
        await safeAppendSessionEvent(sessionEventLog, {
          type: "tool/result",
          sessionId: state.threadId,
          payload: { id: String(toolCall?.id || `t${branchIndex + 1}`), ok: !executed.stoppedReason, resultText: String(executed.result?.contextText || "").slice(0, 4000) },
        });
        allToolCalls.push(toolCall);
        if (executed.stoppedReason && !stoppedReason) stoppedReason = executed.stoppedReason;
        branchIndex += 1;
      }
      const nextStepIndexFanout = Number(state.toolStepIndex || 0) + 1;
      return {
        plannedToolCalls: [],
        toolStepIndex: nextStepIndexFanout,
        stoppedReason: stoppedReason || "deterministic_plan_complete",
        toolCalls,
        toolMessages,
        toolConversationMessages,
        toolEvents,
        toolEvidence,
        toolResultTexts,
        runtimeEvents: [emit(config, { type: "tool-fanout-completed", threadId: state.threadId, ok: fanoutResult.ok.length, failed: fanoutResult.failed.length })],
      };
    }

    for (const toolCall of plannedToolCalls) {
      allToolCalls.push(toolCall);
      const execution = await executeOne(toolCall, { deferCatalogStop: true });
      const result = execution.result;
      if (execution.deferredCatalogStop) {
        const correction = buildGovernedSemanticPlanRetry({
          originalToolCall: toolCall,
          recovery: execution.recovery,
          queryPlan: toolDependencies.governedQueryPlan,
          actorScopeHash: state.actorScope?.scopeHash,
        });
        if (correction && isToolAllowed(primitiveForLegacyTool(correction.toolCall.function.name), selectedToolset)) {
          allToolCalls.push(correction.toolCall);
          await executeOne(correction.toolCall, { catalogRecovery: correction.recovery });
          if (!stoppedReason) {
            stoppedReason = "catalog_retry_completed";
          }
        } else {
          stoppedReason = execution.stoppedReason || "tool_recovery_catalog";
        }
        break;
      }
      if (stoppedReason) {
        break;
      }
      if (isCompletedTopIssueGrowthRank(toolCall, result)) {
        stoppedReason = "top_issue_growth_rank_completed";
        break;
      }
      if (hasEmptyAnalyticsResult(toolCall, result) && !hasPlannedDiagnosis(allToolCalls)) {
        const diagnosisToolCall = buildEmptyDiagnosisToolCall(toolCall);
        allToolCalls.push(diagnosisToolCall);
        const diagnosisExecution = await executeOne(diagnosisToolCall);
        if (stoppedReason) {
          break;
        }
        const correction = buildCatalogBackedAnalyticsRetry({
          originalToolCall: privateAdapterToolCall(toolCall),
          diagnosisToolCall,
          diagnosisResult: diagnosisExecution.result,
        });
        if (correction && isToolAllowed(primitiveForLegacyTool(correction.toolCall.function.name), selectedToolset)) {
          const publicCorrection = toPrimitiveToolCall(correction.toolCall);
          allToolCalls.push(publicCorrection);
          await executeOne(publicCorrection, { catalogRecovery: correction.recovery });
          if (!stoppedReason) {
            stoppedReason = "catalog_retry_completed";
          }
          break;
        }
      }
    }

    const nextStepIndex = Number(state.toolStepIndex || 0) + 1;
    if (!stoppedReason && state.toolExecutionMode === "deterministic") {
      stoppedReason = "deterministic_plan_complete";
    }
    if (!stoppedReason && nextStepIndex >= Math.max(1, Math.min(10, Number(maxToolSteps || 4)))) {
      stoppedReason = "max_steps";
    }
    return {
      plannedToolCalls: [],
      toolStepIndex: nextStepIndex,
      stoppedReason,
      toolCalls,
      toolMessages,
      toolConversationMessages,
      toolEvents,
      toolEvidence,
      toolResultTexts,
    };
  }

  async function finalize(state, config) {
    const body = state.body || {};
    const mainAgentToolContext = state.toolRouting?.shouldUseTools ? buildMainAgentToolContextFromState(state) : null;
    const citationContractContext = buildCitationContractContext({ evidence: mainAgentToolContext?.evidence, registry: ontologyRegistry });
    const guard = budgetGuardFor(config);
    const budgetNote = guard ? guard.budgetNote() : null;
    const dataHealth = dataQualityFootnotesEnabled ? await datasetHealthFromRegistry(ontologyRegistry, { now }) : null;
    const dataQualitySection = dataHealth?.notes?.length
      ? `# Data quality\n${dataHealth.notes.map((note) => `- ${note}`).join("\n")}`
      : null;
    const budgetSection = budgetNote
      ? `# Budget note\n本次会话 token 预算已用尽（${budgetNote.spent}/${budgetNote.budget}），Agent 提前结束工具步骤并降级作答。请在新的会话中继续追问。`
      : null;
    const context = mergeContext(
      state.baseContext,
      mainAgentToolContext?.contextText,
      formatSemanticEvidenceGate(mainAgentToolContext?.evidenceGate),
      citationContractContext,
      dataQualitySection,
      budgetSection,
    );
    const finalMessages = [
      ...(Array.isArray(body?.messages) ? body.messages : []),
    ];
    const prefaceEvents = [
      ...(mainAgentToolContext?.toolEvents || []),
      ...(state.defectContext?.duplicateSearchResult
        ? [
            {
              type: "context",
              context: state.defectContext.contextText,
              result: state.defectContext.duplicateSearchResult,
              timings: state.defectContext.timings,
            },
          ]
        : []),
    ];
    const metrics = {
      runtime: "langgraph",
      runId: state.runId,
      threadId: state.threadId,
      actorId: state.actorScope?.actorId || "",
      queryText: state.queryText,
      aiContextEnabled: body?.useDefectContext === true,
      analyticsContextEnabled: body?.useAnalyticsContext === true,
      mainAgentToolCallCount: mainAgentToolContext?.toolCalls?.length || 0,
      evidenceGate: mainAgentToolContext?.evidenceGate || { status: "not_required", violations: [], analysisRefs: [], sourceRevisionIds: [], warnings: [] },
      toolRouting: state.directResponse
        ? { ...compactToolRouting(state.toolRouting), intent: state.directResponse.intent }
        : compactToolRouting(state.toolRouting),
      aiContextTimings: state.defectContext?.timings || null,
      ...(guard ? { tokenBudget: guard.snapshot() } : {}),
      ...(budgetNote ? { budgetNote } : {}),
      ...(dataHealth ? { dataHealth: { severity: dataHealth.severity, notes: dataHealth.notes } } : {}),
    };
    const directResponse = state.directResponse && dataQualitySection && state.directResponse.intent !== "approval_pending"
      ? { ...state.directResponse, content: withDataQualityFootnote(state.directResponse.content || "", dataHealth) }
      : state.directResponse || null;
    if (sessionEventLog) {
      await safeAppendSessionEvent(sessionEventLog, { type: "turn/end", sessionId: state.threadId, payload: { runId: state.runId, stoppedReason: state.stoppedReason || "no_tool_calls" } });
    }
    const event = emit(config, { type: "agent-runtime-ready", runId: state.runId, threadId: state.threadId });
    return {
      context,
      finalMessages,
      prefaceEvents,
      mainAgentToolContext,
      directResponse,
      metrics,
      runtimeEvents: [event],
    };
  }

  function routeAfterToolRouting(state) {
    return state.toolRouting?.shouldUseTools === true ? "plan_tool_calls" : "finalize";
  }

  function routeAfterPlanning(state) {
    return Array.isArray(state.plannedToolCalls) && state.plannedToolCalls.length ? "execute_tool_calls" : "finalize";
  }

  function routeAfterToolExecution(state) {
    if (["governed_semantic_plan", "defect_reporter_aggregate"].includes(state.plannedToolCallSource)) {
      return "finalize";
    }
    return state.stoppedReason ? "finalize" : "plan_tool_calls";
  }

  const graph = new StateGraph(ChatState)
    .addNode("initialize", initialize)
    .addNode("resolve_context", resolveContext)
    .addNode("route_tools", routeTools)
    .addNode("plan_tool_calls", planToolCalls)
    .addNode("execute_tool_calls", executeToolCalls)
    .addNode("finalize", finalize)
    .addEdge(START, "initialize")
    .addEdge("initialize", "resolve_context")
    .addEdge("resolve_context", "route_tools")
    .addConditionalEdges("route_tools", routeAfterToolRouting)
    .addConditionalEdges("plan_tool_calls", routeAfterPlanning)
    .addConditionalEdges("execute_tool_calls", routeAfterToolExecution)
    .addEdge("finalize", END)
    .compile({ checkpointer });

  return {
    kind: "langgraph",
    graph,
    async invoke({ body = {}, toolDependencies = {} } = {}, { onEvent } = {}) {
      const runId = normalizeRunId(body, now);
      const threadId = normalizeThreadId(body, now);
      let effectiveBody = body;
      // Approval resume: a caller-approved decision unlocks the suspended write-intent call.
      if (approvalFlow && body?.approvalDecision && typeof body.approvalDecision === "object") {
        const decision = String(body.approvalDecision.decision || "");
        const approvalId = String(body.approvalDecision.approvalId || "");
        if (approvalId && ["approved", "rejected", "expired"].includes(decision)) {
          const outcome = await approvalFlow.decide({ approvalId, decision, decidedBy: body.approvalDecision.decidedBy || "user" }).catch(() => null);
          if (outcome?.status === "ok" && decision === "approved" && outcome.handoffState?.toolCall) {
            effectiveBody = { ...body, _approvedToolCall: outcome.handoffState.toolCall };
          }
        }
      }
      const budgetGuard = typeof createBudgetGuard === "function" ? createBudgetGuard() : null;
      let state;
      try {
        state = await graph.invoke(
          { body: effectiveBody, runId, threadId, toolDependencies },
          {
            signal: createRunnableSignal(),
            configurable: {
              thread_id: threadId,
              onEvent,
              ...(budgetGuard ? { tokenBudgetGuard: budgetGuard } : {}),
            },
          },
        );
      } catch (error) {
        await safeAppendSessionEvent(sessionEventLog, {
          type: "error/runtime",
          sessionId: threadId,
          payload: { runId, message: String(error?.message || error).slice(0, 500) },
        });
        await persistRuntimeFailure(runtimeStore, {
          runId,
          threadId,
          actorScope: normalizeActorScope(body),
          queryText: extractLatestUserQuery(body?.messages),
          error,
        });
        throw error;
      }
      // Semantic cache: store verified governed results for reuse.
      if (semanticCache) {
        const governedPlan = state?.analyticsContext?.queryPlan?.status === "valid"
          ? state.analyticsContext.queryPlan
          : state?.analyticsContext?.semanticPlan?.status === "valid"
            ? state.analyticsContext.semanticPlan
            : null;
        const contextText = state?.mainAgentToolContext?.contextText || "";
        if (governedPlan && contextText && state?.stoppedReason !== "budget_exceeded") {
          await semanticCache.set({
            planFingerprint: planCacheKey(governedPlan, state.actorScope),
            queryText: state.queryText || "",
            intent: state?.metrics?.toolRouting?.intent || "",
            result: { contextText: contextText.slice(0, 8000), stoppedReason: state.stoppedReason || "" },
          }).catch(() => null);
        }
      }
      await persistRuntimeState(runtimeStore, state);
      return {
        runtime: "langgraph",
        runId: state.runId || runId,
        threadId: state.threadId || threadId,
        actorScope: state.actorScope || {},
        body: state.body || body,
        queryText: state.queryText || "",
        analyticsContext: state.analyticsContext || null,
        aiContext: state.defectContext || null,
        mainAgentToolContext: state.mainAgentToolContext || null,
        directResponse: state.directResponse || null,
        context: state.context || "",
        finalMessages: state.finalMessages || [],
        prefaceEvents: state.prefaceEvents || [],
        events: toolLifecycleEventsFromContext(state.mainAgentToolContext, { runId: state.runId || runId, threadId: state.threadId || threadId }),
        metrics: state.metrics || {},
        runtimeEvents: state.runtimeEvents || [],
      };
    },
  };
}
