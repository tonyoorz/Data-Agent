import { streamCompanyChatCompletion, writeSseEvent, writeSseResponse } from "../companyChat.mjs";
import { isClaimBearingEvidence } from "../mainAgentEvidence.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";

function createAnswerValidation(runtimeResult) {
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  const semanticEvidence = (Array.isArray(evidence) ? evidence : []).filter(isClaimBearingEvidence);
  if (!semanticEvidence.length) {
    return undefined;
  }
  const evidenceGate = runtimeResult?.mainAgentToolContext?.evidenceGate;
  try {
    return { semanticEvidence, evidenceGate, registry: createOntologyRegistry() };
  } catch {
    return { semanticEvidence, evidenceGate };
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
    answerValidation: createAnswerValidation(runtimeResult),
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
