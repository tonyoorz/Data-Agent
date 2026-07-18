import { createAnswerEnvelope, createClaimsFromEvidence, createLegacyEvidence, createSemanticEvidence, renderDeterministicFallback, validateLegacyClaims, validateRenderedAnswer } from "./evidence.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";
import { createSemanticResolver } from "../ontology/resolver.mjs";
import { createQueryPlanner, validatePlan as validateQueryPlan } from "../ontology/queryPlanner.mjs";
import { buildFocusedClarification, validateSemanticFrame } from "../ontology/semanticFrame.mjs";
import { createSemanticCandidateMessages, createSemanticCandidateSchema, parseSemanticCandidate } from "../ontology/semanticCandidate.mjs";
import { createHash } from "node:crypto";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";

const SEMANTIC_TOOLS = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function hashCanonicalArgs(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function redactCanonicalArgs(canonicalArgs = {}) {
  const query = canonicalArgs.query;
  if (typeof query === "string") {
    return {
      queryRef: hashCanonicalArgs(query).slice(0, 16),
      queryLength: [...query].length,
      ...(Number.isInteger(canonicalArgs.top_k) ? { top_k: canonicalArgs.top_k } : {}),
    };
  }
  if (!query || typeof query !== "object") return {};
  return {
    query: {
      ontologyVersion: query.ontologyVersion,
      schemaFingerprint: query.schemaFingerprint,
      intent: query.intent,
      entityIds: query.entityIds,
      metricIds: query.metricIds,
      dimensionIds: query.dimensionIds,
      filters: (query.filters || []).map((filter) => ({
        dimensionId: filter.dimensionId,
        operator: filter.operator,
        source: filter.source,
        valueCount: Array.isArray(filter.values) ? filter.values.length : 0,
      })),
      timeScopes: (query.timeScopes || []).map((scope) => ({ role: scope.role, fieldId: scope.fieldId, start: scope.start, end: scope.end, timezone: scope.timezone })),
      comparison: query.comparison ? { kind: query.comparison.kind, dimensionId: query.comparison.dimensionId, groupCount: query.comparison.groups?.length || 0 } : null,
      sort: query.sort,
      limit: query.limit,
    },
  };
}

const replace = (_left, right) => right;
const appendById = (key) => (left = [], right = []) => {
  const map = new Map(left.map((item) => [item?.[key], item]));
  for (const item of right || []) map.set(item?.[key], { ...map.get(item?.[key]), ...item });
  return [...map.values()].filter((item) => item?.[key] != null);
};

export const AgentState = Annotation.Root({
  schemaVersion: Annotation({ reducer: replace, default: () => "1.0" }),
  runId: Annotation({ reducer: replace }),
  threadId: Annotation({ reducer: replace }),
  actor: Annotation({ reducer: replace }),
  request: Annotation({ reducer: replace }),
  warnings: Annotation({ reducer: replace, default: () => [] }),
  messages: Annotation({ reducer: appendById("messageId"), default: () => [] }),
  summaries: Annotation({ reducer: appendById("summaryId"), default: () => [] }),
  threadContext: Annotation({ reducer: replace, default: () => ({ messageCount: 0, summaryCount: 0 }) }),
  modelTurns: Annotation({ reducer: appendById("turnId"), default: () => [] }),
  semanticFrame: Annotation({ reducer: replace }),
  plan: Annotation({ reducer: replace }),
  planValidation: Annotation({ reducer: replace }),
  stepCursor: Annotation({ reducer: replace, default: () => 0 }),
  toolResults: Annotation({ reducer: replace, default: () => [] }),
  executionDecision: Annotation({ reducer: replace, default: () => "execute" }),
  replanCount: Annotation({ reducer: replace, default: () => 0 }),
  evidence: Annotation({ reducer: appendById("evidenceId"), default: () => [] }),
  claims: Annotation({ reducer: appendById("claimId"), default: () => [] }),
  claimValidation: Annotation({ reducer: replace }),
  pendingInteraction: Annotation({ reducer: replace }),
  artifacts: Annotation({ reducer: replace, default: () => [] }),
  answerDraft: Annotation({ reducer: replace }),
  answerValidation: Annotation({ reducer: replace }),
  repairCount: Annotation({ reducer: replace, default: () => 0 }),
  answer: Annotation({ reducer: replace }),
});

export function createGraphNodes(deps = {}) {
  const ontologyRegistry = deps.ontologyRegistry || createOntologyRegistry();
  const semanticResolver = deps.semanticResolver || createSemanticResolver({ registry: ontologyRegistry, now: deps.now });
  const queryPlanner = deps.queryPlanner || createQueryPlanner({ registry: ontologyRegistry });
  const emit = deps.emitEvent || (() => {});
  return {
    receiveRequest(state) {
      return { ...state, schemaVersion: "1.0", warnings: [], evidence: [], claims: [], toolResults: [], stepCursor: 0, replanCount: 0, repairCount: 0 };
    },
    async prepareInputs(state) {
      const artifacts = deps.prepareArtifacts
        ? await deps.prepareArtifacts({ actor: state.actor, runId: state.runId, artifactRefs: state.request?.artifactRefs || [] })
        : [];
      const warnings = [...new Set(artifacts.flatMap((item) => item.warningCodes || []))];
      emit({ type: "input.prepared", payload: { artifactRefs: artifacts.map((item) => item.artifactId), warnings } });
      return { ...state, artifacts, warnings };
    },
    async loadThreadContext(state) {
      const context = deps.loadThreadContext
        ? await deps.loadThreadContext({ actor: state.actor, runId: state.runId, threadId: state.threadId })
        : { messages: [], summaries: [] };
      const messages = Array.isArray(context?.messages) ? context.messages : [];
      const summaries = Array.isArray(context?.summaries) ? context.summaries : [];
      deps.telemetry?.record("agent.thread_context", { runId: state.runId, messageCount: messages.length, summaryCount: summaries.length });
      return {
        ...state,
        messages,
        summaries,
        threadContext: { messageCount: messages.length, summaryCount: summaries.length },
      };
    },
    async resolveSemantics(state) {
      const ontologySpan = deps.telemetry?.startSpan("agent.ontology.resolve", { runId: state.runId, node: "resolve_semantics", ontologyVersion: ontologyRegistry.version, ontologyFingerprint: ontologyRegistry.fingerprint });
      let candidate = null;
      let modelTurn;
      const warnings = [...(state.warnings || [])];
      const priorSemanticFrame = [...(state.summaries || [])].reverse().find((item) => item?.body?.semanticFrame)?.body?.semanticFrame || null;
      const priorSemanticContext = priorSemanticFrame ? {
        intent: priorSemanticFrame.intent,
        entityIds: priorSemanticFrame.entityIds,
        metricIds: priorSemanticFrame.metricIds,
        dimensionIds: priorSemanticFrame.dimensionIds,
        timeScopes: priorSemanticFrame.timeScopes,
      } : null;
      if (deps.modelAdapter) {
        const modelId = state.request.selectedModel;
        const span = deps.telemetry?.startSpan("agent.model", { runId: state.runId, modelId, node: "resolve_semantics" });
        try {
          const outputSchema = createSemanticCandidateSchema(ontologyRegistry);
          const response = await deps.modelAdapter.invoke({
            modelId,
            purpose: "planning",
            messages: createSemanticCandidateMessages({ registry: ontologyRegistry, query: state.request.text, priorSemanticContext }),
            outputSchema,
            temperature: 0,
            maxOutputTokens: 512,
            allowParallelToolCalls: false,
          }, deps.executionContext || {});
          candidate = parseSemanticCandidate(response.text, outputSchema);
          modelTurn = {
            turnId: `semantic-${state.runId || "run"}`,
            purpose: "planning",
            modelId,
            status: "completed",
            finishReason: response.finishReason || "stop",
            usage: response.usage || { inputTokens: 0, outputTokens: 0 },
          };
          emit({
            type: "model.completed",
            payload: {
              modelId,
              purpose: "planning",
              finishReason: response.finishReason || "stop",
              inputTokens: Number.isInteger(response.usage?.inputTokens) ? response.usage.inputTokens : 0,
              outputTokens: Number.isInteger(response.usage?.outputTokens) ? response.usage.outputTokens : 0,
            },
          });
          span?.end({ status: "completed", inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens });
        } catch (error) {
          const rawCode = String(error?.code || "");
          const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode) ? rawCode : "MODEL_SEMANTIC_FALLBACK";
          warnings.push("MODEL_SEMANTIC_FALLBACK");
          modelTurn = { turnId: `semantic-${state.runId || "run"}`, purpose: "planning", modelId, status: "fallback", code };
          emit({ type: "model.fallback", payload: { fromModelId: modelId, toModelId: "deterministic-ontology", reasonCode: code } });
          span?.end({ status: "fallback", code, retryable: Boolean(error?.retryable) });
        }
      }
      const semanticFrame = semanticResolver.resolve({ query: state.request.text, actor: state.actor, requestAnchorAt: deps.now?.() || new Date().toISOString(), clarification: state.request.clarification, candidate, priorSemanticFrame });
      emit({ type: "intent.resolved", payload: { intent: semanticFrame.intent, confidence: semanticFrame.confidence } });
      emit({ type: "ontology.resolved", payload: { semanticFrameRef: { ontologyVersion: semanticFrame.ontologyVersion, schemaFingerprint: semanticFrame.schemaFingerprint, requestAnchorAt: semanticFrame.requestAnchorAt }, mode: "ontology_verified", ambiguityCodes: semanticFrame.ambiguities.map((item) => item.code) } });
      ontologySpan?.end({ status: "completed", intent: semanticFrame.intent, metricCount: semanticFrame.metricIds.length, ambiguityCount: semanticFrame.ambiguities.length });
      return { ...state, semanticFrame, warnings: [...new Set(warnings)], ...(modelTurn ? { modelTurns: [modelTurn] } : {}) };
    },
    validateSemantics(state) {
      validateSemanticFrame(state.semanticFrame);
      deps.telemetry?.record("agent.semantics.validated", { runId: state.runId, intent: state.semanticFrame.intent, metricCount: state.semanticFrame.metricIds.length, ambiguityCount: state.semanticFrame.ambiguities.length });
      return state;
    },
    createPlan(state) {
      const span = deps.telemetry?.startSpan("agent.plan.compile", { runId: state.runId, node: "create_plan", ontologyVersion: state.semanticFrame.ontologyVersion });
      const plan = queryPlanner.createPlan({ frame: state.semanticFrame, actor: state.actor, query: state.request.text });
      const clarification = plan.status === "needs_clarification" ? buildFocusedClarification(state.semanticFrame) : null;
      const pendingInteraction = clarification ? { kind: "clarification", ...clarification } : null;
      emit({ type: "plan.updated", payload: { planId: plan.planId, version: plan.version, stepIds: plan.steps.map((step) => step.stepId) } });
      span?.end({ status: plan.status, toolCount: plan.steps.length });
      return { ...state, plan, pendingInteraction, stepCursor: 0, toolResults: [], executionDecision: pendingInteraction ? "wait" : "execute" };
    },
    validatePlan(state) {
      const plan = validateQueryPlan(state.plan);
      if (plan.status === "denied") {
        throw Object.assign(new Error("PLAN_POLICY_DENIED"), { code: "PLAN_POLICY_DENIED", status: "denied", retryable: false });
      }
      if (plan.status === "valid" && deps.policy) {
        for (const [index, step] of plan.steps.entries()) {
          try {
            deps.policy.authorizeTool({ actor: state.actor, request: state.request, runtimeMode: deps.runtimeMode || "langgraph", toolName: step.toolName, externalStepIndex: index, callsInStep: 1 });
          } catch (error) {
            const code = String(error?.code || error?.message || "PLAN_POLICY_DENIED");
            throw Object.assign(new Error(code), { code, status: "denied", retryable: false });
          }
        }
      }
      const planValidation = { status: plan.status, planId: plan.planId, version: plan.version, toolNames: plan.steps.map((step) => step.toolName) };
      emit({ type: "plan.validated", payload: { planId: plan.planId, toolNames: planValidation.toolNames, warnings: plan.warnings || [] } });
      return { ...state, planValidation, executionDecision: plan.status === "needs_clarification" ? "wait" : "execute" };
    },
    waitForClarification(state) {
      const clarification = interrupt(state.pendingInteraction);
      return {
        ...state,
        request: { ...state.request, clarification },
        pendingInteraction: null,
      };
    },
    async executeStep(state) {
      if (state.plan.status !== "valid" || state.stepCursor >= state.plan.steps.length) return { ...state, executionDecision: "build" };
      const step = state.plan.steps[state.stepCursor];
      const completedStepIds = new Set(state.toolResults.filter((item) => ["succeeded", "partial"].includes(item.status)).map((item) => item.stepId));
      const missingDependency = step.dependsOn.find((dependency) => !completedStepIds.has(dependency));
      if (missingDependency) throw Object.assign(new Error(`PLAN_DEPENDENCY_NOT_COMPLETED:${missingDependency}`), { code: "PLAN_DEPENDENCY_NOT_COMPLETED", retryable: false });
      const executionContext = deps.executionContext || {};
      const signal = executionContext.signal || new AbortController().signal;
      const startedAt = Date.now();
      emit({ type: "tool.started", payload: { attemptId: step.stepId, stepId: step.stepId, toolName: step.toolName, redactedCanonicalArgs: redactCanonicalArgs(step.canonicalArgs) } });
      try {
        const execute = () => deps.toolRegistry.execute({ call: { toolCallId: step.stepId, name: step.toolName, argumentsText: JSON.stringify(step.canonicalArgs) }, request: state.request, runtimeMode: deps.runtimeMode || "langgraph", externalStepIndex: state.stepCursor, callsInStep: 1, context: { actor: state.actor, signal, isCancellationRequested: executionContext.isCancellationRequested || (async () => signal.aborted), refreshActor: executionContext.refreshActor || (async () => state.actor), assertCurrentLease: executionContext.assertCurrentLease || (async () => undefined) } });
        const result = deps.stepJournal
          ? await deps.stepJournal.run({ runId: state.runId, nodeId: step.stepId, logicalAttempt: state.replanCount + 1, scopeHash: state.actor.scopeHash, graphDefinitionVersion: deps.graphDefinitionVersion, leaseEpoch: executionContext.leaseEpoch, toolName: step.toolName, toolVersion: deps.toolRegistry.get(step.toolName).version, canonicalArgsHash: hashCanonicalArgs(step.canonicalArgs), boundaryKind: "read" }, execute)
          : await execute();
        const status = result.status === "partial" ? "partial" : "succeeded";
        const toolResult = { stepId: step.stepId, status, toolName: step.toolName, toolVersion: result.toolVersion, canonicalArgs: step.canonicalArgs, rawResult: result.rawResult, retrievedAt: deps.now?.() || new Date().toISOString() };
        emit({ type: "tool.completed", payload: { attemptId: step.stepId, status, evidenceIds: [`ev-${step.stepId}`], durationMs: Math.max(0, Date.now() - startedAt) } });
        return { ...state, toolResults: [...state.toolResults, toolResult], executionDecision: "evaluate" };
      } catch (error) {
        const code = String(error?.code || "TOOL_EXECUTION_FAILED");
        const status = ["denied", "failed", "timeout", "cancelled"].includes(error?.status) ? error.status : "failed";
        emit({ type: "tool.failed", payload: { attemptId: step.stepId, status, code, retryable: Boolean(error?.retryable), safeMessage: code } });
        const canReplan = state.replanCount < 1 && (Boolean(error?.retryable) || code === "TOOL_OUTPUT_TOO_LARGE");
        if (!canReplan) throw error;
        return { ...state, toolResults: [...state.toolResults, { stepId: step.stepId, status: "failed", toolName: step.toolName, code, retryable: Boolean(error?.retryable) }], executionDecision: "replan" };
      }
    },
    evaluateStepResult(state) {
      const current = state.toolResults.at(-1);
      if (!current) throw Object.assign(new Error("TOOL_RESULT_REQUIRED"), { code: "TOOL_RESULT_REQUIRED" });
      if (current.status === "failed") return { ...state, executionDecision: "replan" };
      const hasNext = state.stepCursor + 1 < state.plan.steps.length;
      return { ...state, executionDecision: hasNext ? "continue" : "build" };
    },
    replanOrContinue(state) {
      if (state.executionDecision === "continue") return { ...state, stepCursor: state.stepCursor + 1, executionDecision: "execute" };
      if (state.executionDecision !== "replan") return state;
      const failed = state.plan.steps[state.stepCursor];
      const failure = state.toolResults.at(-1);
      const query = failed.canonicalArgs?.query;
      const narrowedLimit = failure?.code === "TOOL_OUTPUT_TOO_LARGE" && Number.isInteger(query?.limit) && query.limit > 1
        ? Math.max(1, Math.floor(query.limit / 2))
        : query?.limit;
      const replacementId = `${failed.stepId}-r${state.replanCount + 1}`;
      const replacement = {
        ...failed,
        stepId: replacementId,
        canonicalArgs: query ? { ...failed.canonicalArgs, query: { ...query, ...(narrowedLimit ? { limit: narrowedLimit } : {}) } } : failed.canonicalArgs,
      };
      deps.policy?.authorizeTool({ actor: state.actor, request: state.request, runtimeMode: deps.runtimeMode || "langgraph", toolName: replacement.toolName, externalStepIndex: state.stepCursor, callsInStep: 1 });
      const steps = state.plan.steps.map((step, index) => {
        if (index === state.stepCursor) return replacement;
        return { ...step, dependsOn: step.dependsOn.map((dependency) => dependency === failed.stepId ? replacementId : dependency) };
      });
      const plan = validateQueryPlan({ ...state.plan, version: state.plan.version + 1, steps, warnings: [...new Set([...(state.plan.warnings || []), `REPLANNED_AFTER_${failure?.code || "TOOL_FAILURE"}`])] });
      emit({ type: "plan.updated", payload: { planId: plan.planId, version: plan.version, stepIds: plan.steps.map((step) => step.stepId) } });
      emit({ type: "plan.validated", payload: { planId: plan.planId, toolNames: plan.steps.map((step) => step.toolName), warnings: plan.warnings } });
      return { ...state, plan, replanCount: state.replanCount + 1, executionDecision: "execute" };
    },
    buildEvidence(state) {
      const evidence = state.toolResults.filter((result) => ["succeeded", "partial"].includes(result.status)).map((result) => {
        const evidenceInput = { evidenceId: `ev-${result.stepId}`, actor: state.actor, attemptId: result.stepId, toolName: result.toolName, toolVersion: result.toolVersion, canonicalArgs: result.canonicalArgs, rawResult: result.rawResult, retrievedAt: result.retrievedAt, ontologyRegistry };
        return SEMANTIC_TOOLS.has(result.toolName) ? createSemanticEvidence(evidenceInput) : createLegacyEvidence(evidenceInput);
      });
      for (const item of evidence) emit({ type: "evidence.added", payload: { evidenceIds: [item.evidenceId], groundingStatus: item.quality.groundingStatus } });
      return { ...state, evidence };
    },
    validateClaims(state) {
      const span = deps.telemetry?.startSpan("agent.claims.validate", { runId: state.runId, node: "validate_claims", evidenceCount: state.evidence.length });
      const claims = createClaimsFromEvidence({ evidence: state.evidence, ontologyRegistry });
      const claimValidation = validateLegacyClaims({ actor: state.actor, claims, evidence: state.evidence });
      emit({ type: "claims.validated", payload: { validationRef: claimValidation.validationId, acceptedClaimIds: claimValidation.acceptedClaimIds, rejectedClaimIds: claimValidation.rejected.map((item) => item.claimId) } });
      span?.end({ status: claimValidation.status, claimCount: claims.length });
      return { ...state, claims, claimValidation };
    },
    renderAnswer(state) {
      const span = deps.telemetry?.startSpan("agent.answer.render", { runId: state.runId, node: "publish_answer", claimCount: state.claimValidation.acceptedClaimIds.length });
      const acceptedClaims = state.claims.filter((claim) => state.claimValidation.acceptedClaimIds.includes(claim.claimId));
      const acceptedEvidenceIds = new Set(acceptedClaims.flatMap((claim) => claim.evidenceIds || []));
      const acceptedEvidence = state.evidence.filter((item) => acceptedEvidenceIds.has(item.evidenceId));
      const groundingStatus = !acceptedClaims.length
        ? "insufficient_evidence"
        : acceptedEvidence.length && acceptedEvidence.every((item) => item.quality.groundingStatus === "grounded")
          ? "grounded"
          : "legacy_equivalence";
      const limitations = [...new Set(acceptedEvidence.flatMap((item) => [
        ...(item.quality?.warnings || []),
        ...(item.quality?.completeness === "partial" ? ["EVIDENCE_PARTIAL"] : []),
        ...(item.quality?.truncation?.truncated ? ["EVIDENCE_TRUNCATED"] : []),
      ]))];
      if (groundingStatus === "legacy_equivalence") limitations.push("legacy equivalence");
      const citations = acceptedEvidence.map((item) => ({
        citationId: `cite-${item.evidenceId}`,
        label: [
          item.metric ? `${item.metric.metricId}@${item.metric.definitionVersion}` : item.evidenceType,
          item.sourceRevision.sourceId,
          item.sourceRevision.revisionId || item.sourceRevision.status,
          item.sourceRevision.asOf || item.retrievedAt,
        ].filter(Boolean).join(" · "),
        claimIds: acceptedClaims.filter((claim) => claim.evidenceIds?.includes(item.evidenceId)).map((claim) => claim.claimId),
        evidenceIds: [item.evidenceId],
      }));
      const text = acceptedClaims.length ? renderDeterministicFallback({ acceptedClaims, limitations }) : "当前证据不足以回答该问题。";
      const sourceRevisionSet = Object.fromEntries(acceptedEvidence.map((item) => [item.evidenceId, item.sourceRevision]));
      span?.end({ status: "completed", citationCount: citations.length, groundingStatus });
      return { ...state, answerDraft: { text, acceptedClaims, citations, assumptions: state.semanticFrame?.assumptions || [], limitations: acceptedClaims.length ? limitations : ["insufficient evidence"], groundingStatus, sourceRevisionSet } };
    },
    validateAnswer(state) {
      const span = deps.telemetry?.startSpan("agent.answer.validate", { runId: state.runId, node: "validate_answer", claimCount: state.answerDraft.acceptedClaims.length });
      try {
        validateRenderedAnswer({ text: state.answerDraft.text, acceptedClaims: state.answerDraft.acceptedClaims, evidence: state.evidence });
        span?.end({ status: "valid" });
        return { ...state, answerValidation: { status: "valid" } };
      } catch (error) {
        if (state.repairCount < 1) {
          span?.end({ status: "repair", code: error?.code || "ANSWER_VALIDATION_FAILED" });
          return { ...state, answerValidation: { status: "repair", code: String(error?.code || "ANSWER_VALIDATION_FAILED") } };
        }
        span?.end({ status: "failed", code: error?.code || "ANSWER_VALIDATION_FAILED" });
        throw error;
      }
    },
    repairAnswer(state) {
      const acceptedClaims = state.answerDraft.acceptedClaims;
      const text = acceptedClaims.length ? acceptedClaims.map((claim) => claim.text).join("\n") : "当前证据不足以回答该问题。";
      return { ...state, repairCount: state.repairCount + 1, answerDraft: { ...state.answerDraft, text }, answerValidation: { status: "pending" } };
    },
    publishAnswer(state) {
      const draft = state.answerDraft;
      const answer = createAnswerEnvelope({ answerId: `answer-${state.runId || "1"}`, text: draft.text, acceptedClaims: draft.acceptedClaims, citations: draft.citations, assumptions: draft.assumptions, limitations: draft.limitations, groundingStatus: draft.groundingStatus, sourceRevisionSet: draft.sourceRevisionSet });
      return { ...state, answer };
    },
    compactContext(state) {
      deps.telemetry?.record("agent.context.compacted", { runId: state.runId, messageCount: state.messages?.length || 0, summaryCount: state.summaries?.length || 0, evidenceCount: state.evidence?.length || 0 });
      return { ...state, toolResults: [], answerDraft: null, answerValidation: null, summaries: state.summaries || [], messages: state.messages || [], modelTurns: state.modelTurns || [], semanticFrame: state.semanticFrame, evidence: state.evidence || [], pendingInteraction: state.pendingInteraction };
    },
  };
}

export function createMainAgentGraph(deps = {}) {
  const nodes = createGraphNodes(deps);
  let builder = new StateGraph(AgentState)
    .addNode("receive_request", nodes.receiveRequest)
    .addNode("prepare_inputs", nodes.prepareInputs)
    .addNode("load_thread_context", nodes.loadThreadContext)
    .addNode("resolve_semantics", nodes.resolveSemantics)
    .addNode("validate_semantics", nodes.validateSemantics)
    .addNode("create_plan", nodes.createPlan)
    .addNode("validate_plan", nodes.validatePlan)
    .addNode("execute_step", nodes.executeStep)
    .addNode("evaluate_step_result", nodes.evaluateStepResult)
    .addNode("replan_or_continue", nodes.replanOrContinue)
    .addNode("build_evidence", nodes.buildEvidence)
    .addNode("validate_claims", nodes.validateClaims)
    .addNode("render_answer", nodes.renderAnswer)
    .addNode("validate_answer", nodes.validateAnswer)
    .addNode("repair_answer", nodes.repairAnswer)
    .addNode("publish_answer", nodes.publishAnswer)
    .addNode("compact_context", nodes.compactContext)
    .addEdge(START, "receive_request")
    .addEdge("receive_request", "prepare_inputs")
    .addEdge("prepare_inputs", "load_thread_context")
    .addEdge("load_thread_context", "resolve_semantics")
    .addEdge("resolve_semantics", "validate_semantics")
    .addEdge("validate_semantics", "create_plan")
    .addEdge("create_plan", "validate_plan")
    .addEdge("execute_step", "evaluate_step_result")
    .addConditionalEdges("evaluate_step_result", (state) => state.executionDecision, { continue: "replan_or_continue", replan: "replan_or_continue", build: "build_evidence" })
    .addEdge("replan_or_continue", "execute_step")
    .addEdge("build_evidence", "validate_claims")
    .addEdge("validate_claims", "render_answer")
    .addEdge("render_answer", "validate_answer")
    .addConditionalEdges("validate_answer", (state) => state.answerValidation?.status || "repair", { valid: "publish_answer", repair: "repair_answer" })
    .addEdge("repair_answer", "validate_answer")
    .addEdge("publish_answer", "compact_context")
    .addEdge("compact_context", END);

  if (deps.checkpointCoordinator?.saver) {
    builder = builder
      .addNode("wait_for_clarification", nodes.waitForClarification)
      .addConditionalEdges("validate_plan", (state) => state.pendingInteraction ? "wait" : "execute", { wait: "wait_for_clarification", execute: "execute_step" })
      .addEdge("wait_for_clarification", "resolve_semantics");
  } else {
    builder = builder.addConditionalEdges("validate_plan", (state) => state.pendingInteraction ? "wait" : "execute", { wait: END, execute: "execute_step" });
  }

  if (deps.checkpointCoordinator?.saver) {
    return builder.compile({ checkpointer: deps.checkpointCoordinator.saver });
  }
  return builder.compile();
}
