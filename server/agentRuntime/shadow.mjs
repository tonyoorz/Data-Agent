import { createHash } from "node:crypto";
import { summarizeNumericText } from "./telemetry.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function signature(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function safeSignature(value) {
  return /^[a-f0-9]{64}$/.test(String(value || "")) ? String(value) : null;
}

function correlationMessageId(actorId, correlationId) {
  const digest = createHash("sha256").update(`${actorId}:${correlationId}`).digest("hex").slice(0, 32);
  return `shadow-${digest}`;
}

function planningModel(modelRegistry, selectedModel) {
  try {
    return modelRegistry.require(selectedModel, { purpose: "planning" }).id;
  } catch {
    return modelRegistry.require(modelRegistry.defaultModelId, { purpose: "planning" }).id;
  }
}

function safeCode(value, fallback) {
  const raw = String(value || "");
  return /^[A-Z][A-Z0-9_:-]{2,79}$/.test(raw) ? raw : fallback;
}

export function buildShadowSemanticObservation({ semanticFrame, plan } = {}) {
  if (!semanticFrame) return {};
  const semanticShape = {
    intent: semanticFrame.intent,
    entityIds: semanticFrame.entityIds || [],
    metricIds: semanticFrame.metricIds || [],
    dimensionIds: semanticFrame.dimensionIds || [],
    ambiguityCodes: (semanticFrame.ambiguities || []).map((item) => item.code),
  };
  const scopeShape = {
    filters: (semanticFrame.filters || []).map((filter) => ({ dimensionId: filter.dimensionId, operator: filter.operator, values: filter.values || [], source: filter.source })),
    timeScopes: (semanticFrame.timeScopes || []).map((time) => ({ role: time.role, fieldId: time.fieldId, start: time.start, end: time.end, timezone: time.timezone })),
  };
  const toolShape = (plan?.steps || []).map((step) => ({ operation: step.operation, toolName: step.toolName }));
  return {
    semanticSignature: signature(semanticShape),
    scopeSignature: signature(scopeShape),
    toolSignature: signature(toolShape),
  };
}

export function createShadowDispatcher({
  runtime,
  identityResolver,
  config,
  modelRegistry,
  auditStore,
  telemetry,
} = {}) {
  if (!runtime || typeof identityResolver !== "function" || !config || !modelRegistry) {
    throw new Error("SHADOW_DISPATCHER_DEPENDENCIES_REQUIRED");
  }

  async function dispatch({ request, correlationId, queryText, selectedModel, useDefectContext, useAnalyticsContext }) {
    const text = String(queryText || "").trim();
    if (!text) return null;
    const actor = await identityResolver(request);
    if (!actor?.actorId) return null;
    const runtimeMode = config.resolveRuntimeMode ? config.resolveRuntimeMode(actor.actorId) : config.mode;
    if (runtimeMode !== "shadow") return null;

    const modelId = planningModel(modelRegistry, selectedModel);
    const started = await runtime.startRun({
      actor,
      runtimeMode: "shadow",
      request: {
        schemaVersion: "1.0",
        messageId: correlationMessageId(actor.actorId, correlationId),
        threadVersion: 0,
        message: { role: "user", text, artifactRefs: [] },
        selectedModel: modelId,
        useDefectContext: useDefectContext === true,
        useAnalyticsContext: useAnalyticsContext === true,
        eventProtocolVersion: "1.0",
      },
    });
    auditStore?.append({
      actor,
      threadId: started.threadId,
      runId: started.runId,
      action: "runtime.shadow_dispatch",
      details: { correlationId, selectedModelId: modelId },
    });
    telemetry?.record("agent.shadow.dispatch", { runId: started.runId, status: "started", modelId });
    return { ...started, actor, correlationId };
  }

  function recordLegacyOutcome({ shadow, status, metrics = {}, code = null }) {
    if (!shadow) return;
    const normalizedCode = code ? safeCode(code, "LEGACY_CHAT_FAILED") : null;
    const details = {
      correlationId: shadow.correlationId,
      status,
      modelId: metrics.model || null,
      durationMs: metrics.streamTotalMs ?? null,
      answerContentHash: metrics.answerContentHash || null,
      answerCharacterCount: metrics.answerCharacterCount ?? null,
      numericTokenCount: Number.isInteger(metrics.numericTokenCount) ? metrics.numericTokenCount : null,
      numericSignature: safeSignature(metrics.numericSignature),
      semanticSignature: safeSignature(metrics.semanticSignature),
      scopeSignature: safeSignature(metrics.scopeSignature),
      toolSignature: safeSignature(metrics.toolSignature),
      ...(normalizedCode ? { code: normalizedCode } : {}),
    };
    auditStore?.append({
      actor: shadow.actor,
      threadId: shadow.threadId,
      runId: shadow.runId,
      action: "runtime.shadow_legacy_result",
      details,
    });
    telemetry?.record("agent.shadow.legacy", { runId: shadow.runId, status, modelId: metrics.model || "unknown", code: normalizedCode || undefined, durationMs: metrics.streamTotalMs });
  }

  return Object.freeze({ dispatch, recordLegacyOutcome });
}

export function buildShadowRuntimeResult({ state, durationMs, status = "completed", code = null } = {}) {
  const frame = state?.semanticFrame;
  const numericSummary = summarizeNumericText(state?.answer?.text || "");
  return {
    status,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    ...(code ? { code: safeCode(code, "SHADOW_RUNTIME_FAILED") } : {}),
    semanticFrame: frame ? {
      intent: frame.intent,
      entityIds: frame.entityIds || [],
      metricIds: frame.metricIds || [],
      dimensionIds: frame.dimensionIds || [],
      ambiguityCodes: (frame.ambiguities || []).map((item) => item.code),
    } : null,
    tools: (state?.plan?.steps || []).map((step) => step.toolName).filter(Boolean),
    evidenceCount: state?.evidence?.length || 0,
    acceptedClaimCount: state?.claimValidation?.acceptedClaimIds?.length || 0,
    citationCount: state?.answer?.citations?.length || 0,
    groundingStatus: state?.answer?.groundingStatus || "pending",
    answerContentHash: state?.answer?.contentHash || null,
    answerCharacterCount: typeof state?.answer?.text === "string" ? [...state.answer.text].length : null,
    ...numericSummary,
    ...buildShadowSemanticObservation({ semanticFrame: frame, plan: state?.plan }),
  };
}
