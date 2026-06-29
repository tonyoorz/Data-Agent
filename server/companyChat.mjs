import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";
import { expandMessagesWithDocumentText } from "./documentText.mjs";
import { expandImageMessagesWithOcr } from "./imageOcr.mjs";

const SYSTEM_PROMPT = `You are DTSV Intelligence — a senior data analyst embedded in a quality engineering dashboard.

# Output protocol (strict)
Before the final answer, narrate your work as an agent does, using these special tags. The UI parses them.

1. <think>...</think> — your private reasoning. 1-4 short sentences. Use it once at the start, and again only if you change direction.
2. <step title="..." source="...">one-line result</step> — represent each analytical action you take, in order. title is what you are doing; source is the data slice; the body is the one-line finding. Emit 2-5 steps for non-trivial questions.
3. <cite source="...">label</cite> — inline citation chips inside the final answer, pointing to the dashboard module or table the claim depends on.
4. Then the final markdown answer (Signal → Diagnosis → Recommendation).

# Style
- Direct, structured, grounded. No "Certainly!", no "As an AI".
- Concise markdown: short paragraphs, bullet lists, small tables.
- Numbers and concrete reasoning, not vague claims.
- If data is missing, emit one <step> noting the gap, then ask one sharp clarifying question.
- Respond in the user's language (Chinese or English).`;

function normalizeAssistantContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part?.image_url?.url === "string") {
            return "[image]";
          }
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function buildMergedMessages(messages, context) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context
      ? [
          {
            role: "system",
            content: `# Current dashboard context\n${context}`,
          },
        ]
      : []),
    ...(Array.isArray(messages) ? messages : []),
  ];
}

function nowMs() {
  return performance.now();
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

export async function requestCompanyChatCompletion({ messages, model, context, imageOcrRunner, documentTextRunner }) {
  const config = resolveChatModelConfig(model || "", process.env);
  if (!config.credential) {
    throw new Error(
      "Company model credentials are not configured. Set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY.",
    );
  }

  const documentExpandedMessages = await expandMessagesWithDocumentText(messages, process.env, { documentTextRunner });
  const preparedMessages = await expandImageMessagesWithOcr(documentExpandedMessages, process.env, { imageOcrRunner });
  const mergedMessages = buildMergedMessages(preparedMessages, context);

  const requestConfig = buildChatCompletionRequest({
    selectedModel: config.model,
    messages: mergedMessages,
    env: process.env,
  });

  const response = await fetch(requestConfig.url, {
    method: "POST",
    headers: requestConfig.headers,
    body: JSON.stringify(requestConfig.body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Chat request failed (${response.status}): ${text || response.statusText}`);
  }

  const payload = await response.json();
  const content = normalizeAssistantContent(payload?.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("Chat model returned empty content");
  }

  return {
    content,
    answerModel: config.model,
  };
}

export async function streamCompanyChatCompletion({
  messages,
  model,
  context,
  response,
  prefaceEvents = [],
  onMetrics,
  imageOcrRunner,
  documentTextRunner,
}) {
  const startedAt = nowMs();
  const config = resolveChatModelConfig(model || "", process.env);
  if (!config.credential) {
    throw new Error(
      "Company model credentials are not configured. Set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY.",
    );
  }

  const documentExpandedMessages = await expandMessagesWithDocumentText(messages, process.env, { documentTextRunner });
  const preparedMessages = await expandImageMessagesWithOcr(documentExpandedMessages, process.env, { imageOcrRunner });
  const mergedMessages = buildMergedMessages(preparedMessages, context);
  const requestConfig = buildChatCompletionRequest({
    selectedModel: config.model,
    messages: mergedMessages,
    env: process.env,
    stream: true,
  });

  let upstreamConnectMs = null;
  let firstChunkMs = null;
  let chunkCount = 0;
  let byteCount = 0;
  let responseStatus = null;
  let streamError = null;

  try {
    const upstreamResponse = await fetch(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.body),
    });
    responseStatus = upstreamResponse.status;
    upstreamConnectMs = roundMs(nowMs() - startedAt);

    if (!upstreamResponse.ok) {
      const text = await upstreamResponse.text().catch(() => "");
      throw new Error(`Chat request failed (${upstreamResponse.status}): ${text || upstreamResponse.statusText}`);
    }

    if (!upstreamResponse.body) {
      throw new Error("Chat model did not return a stream body");
    }

    ensureSseHeaders(response);

    for (const event of prefaceEvents) {
      writeSseEvent(response, event);
    }

    const reader = upstreamResponse.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value?.length) {
        chunkCount += 1;
        byteCount += value.length;
        if (firstChunkMs === null) {
          firstChunkMs = roundMs(nowMs() - startedAt);
        }
        response.write(Buffer.from(value));
      }
    }

    response.end();
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    onMetrics?.({
      model: config.model,
      status: responseStatus,
      upstreamConnectMs,
      firstChunkMs,
      streamTotalMs: roundMs(nowMs() - startedAt),
      chunkCount,
      byteCount,
      error: streamError,
    });
  }
}

function ensureSseHeaders(response) {
  if (response.headersSent) {
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.flushHeaders?.();
}

export function writeSseEvent(response, payload) {
  ensureSseHeaders(response);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseResponse(response, content) {
  ensureSseHeaders(response);

  const chunks = content.match(/.{1,120}/gs) || [content];
  for (const chunk of chunks) {
    writeSseEvent(response, { choices: [{ delta: { content: chunk } }] });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}
