import {
  streamCompanyChatCompletion,
  writeGovernedEvidenceBlockResponse,
  writeSseEvent,
  writeSseResponse,
} from "../companyChat.mjs";
import { evaluateClaimEvidence } from "../mainAgentEvidence.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";

const FINAL_STREAM_FAILURE_CODE = "FINAL_STREAM_FAILED";

function blockedAnswerValidation(violations = []) {
  const normalized = [...new Set((Array.isArray(violations) ? violations : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  return {
    valid: false,
    violations: normalized.length ? normalized : ["SEMANTIC_EVIDENCE_GATE_BLOCKED"],
  };
}

function declaredEvidenceGate(runtimeResult) {
  return runtimeResult?.mainAgentToolContext?.evidenceGate || runtimeResult?.metrics?.evidenceGate || null;
}

function resolveReleaseGate(runtimeResult) {
  const declaredGate = declaredEvidenceGate(runtimeResult);
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  const executedToolCalls = Array.isArray(runtimeResult?.mainAgentToolContext?.toolCalls)
    ? runtimeResult.mainAgentToolContext.toolCalls
    : [];
  if (!declaredGate || declaredGate.status === "not_required") {
    const derivedGate = evaluateClaimEvidence(evidence, {
      expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash,
      executedToolCalls,
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
  const gate = evaluateClaimEvidence(evidence, {
    expectedActorScopeHash: runtimeResult?.actorScope?.scopeHash,
    expectedSourceRevisionIds: declaredGate.sourceRevisionIds,
    requireReleaseBinding: true,
    executedToolCalls,
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
      executedToolCalls: runtimeResult?.mainAgentToolContext?.toolCalls || [],
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
      executedToolCalls: runtimeResult?.mainAgentToolContext?.toolCalls || [],
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
  let completionObserved = false;
  const complete = async (result) => {
    if (completionObserved) return result;
    completionObserved = true;
    try {
      await onCompleted?.(result);
    } catch {
      // Completion observers are best effort and cannot affect an ended response.
    }
    return result;
  };
  const runtimeResult = await runtime.invoke(
    { body, toolDependencies },
    {
      onEvent: (event) => {
        try {
          writeEvent(response, { type: "agent-runtime-event", event });
        } catch {
          // A disconnected client must not abort governed execution or its terminal audit.
        }
      },
    },
  );

  const releaseGate = resolveReleaseGate(runtimeResult);
  if (releaseGate?.status === "blocked") {
    answerValidationResult = blockedAnswerValidation(releaseGate.violations);
    streamMetrics = { evidenceReleaseBlocked: true, finalModelInvoked: false };
    const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
    try {
      answerValidationResult = writeGovernedEvidenceBlockResponse(response, releaseGate.violations);
      result.answerValidation = answerValidationResult;
    } catch {
      // The release decision is still auditable when the client has disconnected.
    } finally {
      await complete(result);
    }
    return result;
  }

  if (releaseGate?.status === "pass"
    && typeof runtimeResult?.directResponse?.content === "string"
    && runtimeResult.directResponse.content.trim()) {
    answerValidationResult = blockedAnswerValidation(["ANSWER_DIRECT_RESPONSE_CLAIM_BYPASS_BLOCKED"]);
    streamMetrics = { evidenceReleaseBlocked: true, finalModelInvoked: false };
    const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
    try {
      answerValidationResult = writeGovernedEvidenceBlockResponse(response, answerValidationResult.violations);
      result.answerValidation = answerValidationResult;
    } catch {
      // The release decision is still auditable when the client has disconnected.
    } finally {
      await complete(result);
    }
    return result;
  }

  if (typeof runtimeResult?.directResponse?.content === "string" && runtimeResult.directResponse.content.trim()) {
    const result = { runtimeResult, streamMetrics: { directResponse: true }, answerValidation: null };
    try {
      writeSseResponse(response, runtimeResult.directResponse.content);
    } catch {
      // A client write failure cannot suppress completion observation.
    } finally {
      await complete(result);
    }
    return result;
  }

  try {
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
  } catch {
    const { error: _providerError, ...safeMetrics } = streamMetrics && typeof streamMetrics === "object" ? streamMetrics : {};
    streamMetrics = {
      ...safeMetrics,
      terminalStatus: "failed",
      failureCode: FINAL_STREAM_FAILURE_CODE,
    };
    answerValidationResult = { valid: false, violations: [FINAL_STREAM_FAILURE_CODE] };
    const failureResult = {
      runtimeResult,
      streamMetrics,
      answerValidation: answerValidationResult,
      terminal: { status: "failed", code: FINAL_STREAM_FAILURE_CODE },
    };
    try {
      if (!response?.writableEnded) {
        try {
          writeEvent(response, {
            type: "agent-terminal",
            status: "failed",
            code: FINAL_STREAM_FAILURE_CODE,
          });
        } catch {
          // A disconnected client cannot prevent terminal audit completion.
        }
        try {
          response.write("data: [DONE]\n\n");
        } catch {
          // Best effort only after the provider has already failed.
        }
        try {
          response.end();
        } catch {
          // Best effort only after the provider has already failed.
        }
      }
    } finally {
      await complete(failureResult);
    }
    return failureResult;
  }

  const result = { runtimeResult, streamMetrics, answerValidation: answerValidationResult };
  return complete(result);
}
