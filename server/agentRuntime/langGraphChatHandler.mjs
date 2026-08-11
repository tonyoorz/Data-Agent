import { streamCompanyChatCompletion, writeSseEvent, writeSseResponse } from "../companyChat.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";

const CLAIM_BEARING_SEMANTIC_TOOLS = new Set(["query_semantic_metrics", "query_semantic_records"]);

function createAnswerValidation(runtimeResult) {
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  const semanticEvidence = (Array.isArray(evidence) ? evidence : []).filter((item) => CLAIM_BEARING_SEMANTIC_TOOLS.has(item?.tool));
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
} = {}) {
  let streamMetrics = null;
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
    return { runtimeResult, streamMetrics: { directResponse: true } };
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
    onMetrics: (metrics) => {
      streamMetrics = metrics;
    },
  });

  return { runtimeResult, streamMetrics };
}