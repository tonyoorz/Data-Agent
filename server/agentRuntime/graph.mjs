import { createAnswerEnvelope, createLegacyEvidence, renderDeterministicFallback, validateLegacyClaims, validateRenderedAnswer } from "./evidence.mjs";
import { createLegacySemanticAdapter, validateLegacyPlan } from "./legacyAdapter.mjs";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

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
  modelTurns: Annotation({ reducer: appendById("turnId"), default: () => [] }),
  semanticFrame: Annotation({ reducer: replace }),
  plan: Annotation({ reducer: replace }),
  evidence: Annotation({ reducer: appendById("evidenceId"), default: () => [] }),
  claims: Annotation({ reducer: appendById("claimId"), default: () => [] }),
  claimValidation: Annotation({ reducer: replace }),
  pendingInteraction: Annotation({ reducer: replace }),
  answer: Annotation({ reducer: replace }),
});

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
  const builder = new StateGraph(AgentState)
    .addNode("receive_request", nodes.receiveRequest)
    .addNode("prepare_inputs", nodes.prepareInputs)
    .addNode("resolve_semantics", nodes.resolveSemantics)
    .addNode("create_plan", nodes.createPlan)
    .addNode("execute_tool", nodes.executeTool)
    .addNode("validate_claims", nodes.validateClaims)
    .addNode("publish_answer", nodes.publishAnswer)
    .addEdge(START, "receive_request")
    .addEdge("receive_request", "prepare_inputs")
    .addEdge("prepare_inputs", "resolve_semantics")
    .addEdge("resolve_semantics", "create_plan")
    .addEdge("create_plan", "execute_tool")
    .addEdge("execute_tool", "validate_claims")
    .addEdge("validate_claims", "publish_answer")
    .addEdge("publish_answer", END);

  if (deps.checkpointCoordinator?.saver) {
    return builder.compile({ checkpointer: deps.checkpointCoordinator.saver });
  }
  return builder.compile();
}