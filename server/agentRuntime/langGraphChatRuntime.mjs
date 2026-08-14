import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

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
  now = () => new Date(),
} = {}) {
  ensureAbortSignalCompatibility();

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
    const planningResult = await requestToolCompletion({
      messages: [
        ...(Array.isArray(body?.messages) ? body.messages : []),
        ...(state.toolConversationMessages || []).slice(Number(state.turnToolConversationStart || 0)),
      ],
      model: body?.model,
      context: mergeContext(
        state.baseContext,
        buildToolPlanningContext(now()),
        buildSelectedToolsetContext(selectedToolset),
        buildSemanticContinuationContext(state.toolEvidence || [], state.actorScope),
      ),
      tools: selectedToolset.tools,
      toolChoice: "auto",
    });
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

  async function executeToolCalls(state) {
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

    async function executeOne(toolCall, { catalogRecovery = null, deferCatalogStop = false } = {}) {
      toolCalls.push(toolCall);
      toolConversationMessages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
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
    const context = mergeContext(
      state.baseContext,
      mainAgentToolContext?.contextText,
      formatSemanticEvidenceGate(mainAgentToolContext?.evidenceGate),
      citationContractContext,
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
    };
    const event = emit(config, { type: "agent-runtime-ready", runId: state.runId, threadId: state.threadId });
    return {
      context,
      finalMessages,
      prefaceEvents,
      mainAgentToolContext,
      directResponse: state.directResponse || null,
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
      let state;
      try {
        state = await graph.invoke(
          { body, runId, threadId, toolDependencies },
          {
            signal: createRunnableSignal(),
            configurable: {
              thread_id: threadId,
              onEvent,
            },
          },
        );
      } catch (error) {
        await persistRuntimeFailure(runtimeStore, {
          runId,
          threadId,
          actorScope: normalizeActorScope(body),
          queryText: extractLatestUserQuery(body?.messages),
          error,
        });
        throw error;
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
