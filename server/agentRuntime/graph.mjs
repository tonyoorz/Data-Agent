import { createAnswerEnvelope, createLegacyEvidence, renderDeterministicFallback, validateLegacyClaims, validateRenderedAnswer } from "./evidence.mjs";
import { createLegacySemanticAdapter, validateLegacyPlan } from "./legacyAdapter.mjs";

function makeClaimFromEvidence(evidence) {
  const payload = evidence.preview?.payload || {};
  const count = payload?.overview?.ticket_count ?? payload?.ticket_count ?? payload?.count;
  if (Number.isFinite(count)) {
    return { claimId: `claim-${evidence.evidenceId}`, type: "observed", text: `2026 年共有 ${count} 个缺陷。`, fact: { subjectRef: "DTSV", predicateId: "defect.count", value: count, scopeEvidenceId: evidence.evidenceId }, evidenceIds: [evidence.evidenceId] };
  }
  return { claimId: `claim-${evidence.evidenceId}`, type: "limitation", text: "当前证据不足以形成确定数字。", evidenceIds: [evidence.evidenceId] };
}

function buildPlan(frame, state) {
  const query = state.request.text;
  const toolName = frame.preferredToolName;
  if (toolName === "search_duplicates") return { steps: [{ stepId: "s1", toolName, canonicalArgs: { query, top_k: 5 }, dependsOn: [] }] };
  if (toolName === "query_defect_high_frequency_analysis") return { steps: [{ stepId: "s1", toolName, canonicalArgs: { filters: { recent_days: 7 }, limit: 12 }, dependsOn: [] }] };
  return { steps: [{ stepId: "s1", toolName: "query_dashboard_summary", canonicalArgs: { filters: { years: 2026 } }, dependsOn: [] }] };
}

export function createGraphNodes(deps = {}) {
  const semanticAdapter = deps.semanticAdapter || createLegacySemanticAdapter({ now: deps.now });
  const emit = deps.emitEvent || (() => {});
  return {
    receiveRequest(state) {
      return { ...state, schemaVersion: "1.0", warnings: [], evidence: [], claims: [] };
    },
    prepareInputs(state) {
      emit({ type: "input.prepared", payload: { artifactRefs: state.request?.artifactRefs || [], warnings: [] } });
      return state;
    },
    resolveSemantics(state) {
      const semanticFrame = semanticAdapter.resolve({ query: state.request.text, actor: state.actor });
      emit({ type: "ontology.resolved", payload: { semanticFrameRef: semanticFrame.ref, mode: semanticFrame.mode, ambiguityCodes: [] } });
      return { ...state, semanticFrame };
    },
    createPlan(state) {
      const candidate = buildPlan(state.semanticFrame, state);
      const plan = validateLegacyPlan({ candidate, actor: state.actor, request: state.request, runtimeMode: "langgraph", policy: deps.policy });
      emit({ type: "plan.validated", payload: { planId: "legacy-plan", toolNames: plan.steps.map((step) => step.toolName), warnings: plan.warnings || [] } });
      return { ...state, plan };
    },
    async executeTool(state) {
      if (state.plan.status !== "valid") return state;
      const evidence = [];
      const executionContext = deps.executionContext || {};
      for (const [index, step] of state.plan.steps.entries()) {
        const signal = executionContext.signal || new AbortController().signal;
        const result = await deps.toolRegistry.execute({ call: { toolCallId: step.stepId, name: step.toolName, argumentsText: JSON.stringify(step.canonicalArgs) }, request: state.request, runtimeMode: "langgraph", externalStepIndex: index, callsInStep: 1, context: { actor: state.actor, signal, isCancellationRequested: executionContext.isCancellationRequested || (async () => signal.aborted), refreshActor: executionContext.refreshActor || (async () => state.actor), assertCurrentLease: executionContext.assertCurrentLease || (async () => undefined) } });
        const item = createLegacyEvidence({ evidenceId: `ev-${step.stepId}`, actor: state.actor, attemptId: step.stepId, toolName: step.toolName, toolVersion: result.toolVersion, canonicalArgs: step.canonicalArgs, rawResult: result.rawResult, retrievedAt: deps.now?.() || new Date().toISOString() });
        evidence.push(item);
        emit({ type: "evidence.added", payload: { evidenceIds: [item.evidenceId], groundingStatus: item.quality.groundingStatus } });
      }
      return { ...state, evidence };
    },
    validateClaims(state) {
      const claims = state.evidence.map(makeClaimFromEvidence);
      const claimValidation = validateLegacyClaims({ actor: state.actor, claims, evidence: state.evidence });
      emit({ type: "claims.validated", payload: { validationRef: claimValidation.validationId, acceptedClaimIds: claimValidation.acceptedClaimIds, rejectedClaimIds: claimValidation.rejected.map((item) => item.claimId) } });
      return { ...state, claims, claimValidation };
    },
    publishAnswer(state) {
      const acceptedClaims = state.claims.filter((claim) => state.claimValidation.acceptedClaimIds.includes(claim.claimId));
      const text = acceptedClaims.length ? renderDeterministicFallback({ acceptedClaims, limitations: ["legacy equivalence"] }) : "当前证据不足以回答该问题。";
      validateRenderedAnswer({ text, acceptedClaims, evidence: state.evidence });
      const answer = createAnswerEnvelope({ answerId: "answer-1", text, acceptedClaims, citations: [], assumptions: [], limitations: acceptedClaims.length ? ["legacy equivalence"] : ["insufficient evidence"], groundingStatus: acceptedClaims.length ? "legacy_equivalence" : "insufficient_evidence", sourceRevisionSet: {} });
      emit({ type: "answer.delta", payload: { answerId: answer.answerId, contentHash: answer.contentHash, offset: 0, text: answer.text } });
      return { ...state, answer };
    },
    compactContext(state) {
      return { ...state, summaries: state.summaries || [], messages: state.messages || [], modelTurns: state.modelTurns || [], semanticFrame: state.semanticFrame, evidence: state.evidence || [], pendingInteraction: state.pendingInteraction };
    },
  };
}

export function createMainAgentGraph(deps = {}) {
  const nodes = createGraphNodes(deps);
  return {
    async invoke(input) {
      let state = nodes.receiveRequest(input);
      state = nodes.prepareInputs(state);
      state = nodes.resolveSemantics(state);
      state = nodes.createPlan(state);
      state = await nodes.executeTool(state);
      state = nodes.validateClaims(state);
      state = nodes.publishAnswer(state);
      return state;
    },
  };
}