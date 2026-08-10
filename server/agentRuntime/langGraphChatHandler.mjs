import {
  streamCompanyChatCompletion,
  writeGovernedEvidenceBlockResponse,
  writeSseEvent,
  writeSseResponse,
} from "../companyChat.mjs";
import { evaluateSemanticEvidence } from "../mainAgentEvidence.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";

function declaredEvidenceGate(runtimeResult) {
  return runtimeResult?.mainAgentToolContext?.evidenceGate || runtimeResult?.metrics?.evidenceGate || null;
}

function resolveReleaseGate(runtimeResult) {
  const declaredGate = declaredEvidenceGate(runtimeResult);
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  if (!declaredGate || declaredGate.status === "not_required") {
    const derivedGate = evaluateSemanticEvidence(evidence, {
      expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash,
    });
    if (derivedGate.status === "not_required") {
      return declaredGate;
    }
    return {
      ...derivedGate,
      status: "blocked",
      violations: [
        declaredGate ? "SEMANTIC_EVIDENCE_GATE_STATUS_MISMATCH" : "SEMANTIC_EVIDENCE_GATE_MISSING",
        ...derivedGate.violations,
      ],
    };
  }
  if (declaredGate.status === "blocked") {
    return declaredGate;
  }
  if (declaredGate.status !== "pass") {
    return {
      status: "blocked",
      violations: ["SEMANTIC_EVIDENCE_GATE_INVALID"],
      analysisRefs: [],
      sourceRevisionIds: [],
      warnings: [],
    };
  }
  const gate = evaluateSemanticEvidence(evidence, {
    expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash,
    expectedSourceRevisionIds: declaredGate.sourceRevisionIds,
    requireReleaseBinding: true,
  });
  if (gate.status === "pass") {
    return gate;
  }
  return {
    ...gate,
    status: "blocked",
    violations: gate.status === "not_required"
      ? ["SEMANTIC_CLAIM_EVIDENCE_MISSING"]
      : gate.violations,
  };
}

function createAnswerValidation(runtimeResult, releaseGate) {
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  if (!Array.isArray(evidence) || !evidence.length) {
    return undefined;
  }
  try {
    return {
      evidence,
      registry: createOntologyRegistry(),
      ...(releaseGate?.status === "pass" ? {
        releaseRequired: true,
        expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash || "",
        expectedSourceRevisionIds: releaseGate.sourceRevisionIds || [],
      } : {}),
    };
  } catch {
    return {
      evidence,
      ...(releaseGate?.status === "pass" ? {
        releaseRequired: true,
        expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash || "",
        expectedSourceRevisionIds: releaseGate.sourceRevisionIds || [],
      } : {}),
    };
  }
}

export async function streamLangGraphChatResponse({
  body = {},
  response,
  runtime,
  toolDependencies = {},
  streamCompletion = streamCompanyChatCompletion,
  writeEvent = writeSseEvent,
  imageOcrRunner,
  documentTextRunner,
  onCompleted,
} = {}) {
  let streamMetrics = null;
  let answerValidationResult = null;
  const runtimeResult = await runtime.invoke(
    { body, toolDependencies },
    {
      onEvent: (event) => {
        writeEvent(response, { type: "agent-runtime-event", event });
      },
    },
  );

  const releaseGate = resolveReleaseGate(runtimeResult);
  if (releaseGate?.status === "blocked") {
    answerValidationResult = writeGovernedEvidenceBlockResponse(response, releaseGate.violations);
    streamMetrics = { evidenceReleaseBlocked: true, finalModelInvoked: false };
    const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
    try {
      await onCompleted?.(result);
    } catch {
      // Completion observers are best effort and cannot affect an ended response.
    }
    return result;
  }

  if (releaseGate?.status === "pass"
    && typeof runtimeResult?.directResponse?.content === "string"
    && runtimeResult.directResponse.content.trim()) {
    answerValidationResult = writeGovernedEvidenceBlockResponse(response, ["ANSWER_DIRECT_RESPONSE_CLAIM_BYPASS_BLOCKED"]);
    streamMetrics = { evidenceReleaseBlocked: true, finalModelInvoked: false };
    const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
    try {
      await onCompleted?.(result);
    } catch {
      // Completion observers are best effort and cannot affect an ended response.
    }
    return result;
  }

  if (typeof runtimeResult?.directResponse?.content === "string" && runtimeResult.directResponse.content.trim()) {
    writeSseResponse(response, runtimeResult.directResponse.content);
    const result = { runtimeResult, streamMetrics: { directResponse: true }, answerValidation: null };
    try {
      await onCompleted?.(result);
    } catch {
      // Completion observers are best effort and cannot affect an ended response.
    }
    return result;
  }

  await streamCompletion({
    messages: runtimeResult.finalMessages,
    model: body?.model,
    context: runtimeResult.context,
    response,
    prefaceEvents: runtimeResult.prefaceEvents,
    imageOcrRunner,
    documentTextRunner,
    answerValidation: createAnswerValidation(runtimeResult, releaseGate),
    onAnswerValidation: (validation) => {
      answerValidationResult = validation;
    },
    onMetrics: (metrics) => {
      streamMetrics = metrics;
    },
  });

  const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
  try {
    await onCompleted?.(result);
  } catch {
    // Completion observers are best effort and cannot affect an ended response.
  }
  return result;
}
