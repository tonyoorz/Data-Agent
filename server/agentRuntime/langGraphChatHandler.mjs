import { streamCompanyChatCompletion, writeSseEvent, writeSseResponse } from "../companyChat.mjs";
import { createOntologyRegistry } from "../ontology/registry.mjs";

function createAnswerValidation(runtimeResult) {
  const evidence = runtimeResult?.mainAgentToolContext?.evidence;
  if (!Array.isArray(evidence) || !evidence.length) {
    return undefined;
  }
  try {
    return { evidence, registry: createOntologyRegistry() };
  } catch {
    return { evidence };
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