import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";
import { compactChatMessages } from "./chatMessageBudget.mjs";
import { expandMessagesWithDocumentText } from "./documentText.mjs";
import { expandImageMessagesWithOcr } from "./imageOcr.mjs";

const SYSTEM_PROMPT = `You are DTSV Intelligence — a senior data analyst embedded in a quality engineering dashboard.

# Output protocol (strict)
Before the final answer, show only grounded, visible analysis steps using these special tags. The UI parses them.

1. <step title="..." source="...">one-line result</step> — summarize a real supplied context block, tool result, attachment extraction, or data limitation. Only emit <step> for evidence you actually received in the messages or system context.
2. <cite source="...">label</cite> — inline citation chips inside the final answer, pointing to the dashboard module, tool, or table the claim depends on.
3. Then the final markdown answer (Signal → Diagnosis → Recommendation).

# Tool boundary
- Tool use happens only before this final answer stage. Never emit DSML, <｜DSML｜tool_calls>, raw tool_calls JSON, XML-like tool invocations, or any other pseudo tool-call syntax in the final answer.
- If more data is needed, state the limitation and answer from the available evidence instead of attempting another tool call.

# Grounding rules
- Do not invent tool use, database queries, files, modules, or hidden work.
- If no tool result or relevant context is supplied, do not claim that you searched or queried data.
- If data is missing, emit one <step> noting the gap, then ask one sharp clarifying question.
- Treat "# Main agent tool result" blocks and tool messages as factual data, but preserve their scope and caveats.

# Style
- Direct, structured, grounded. No "Certainly!", no "As an AI".
- Concise markdown: short paragraphs, bullet lists, small tables.
- Numbers and concrete reasoning, not vague claims.
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

const PSEUDO_TOOL_FALLBACK_CONTENT = "工具调用阶段已结束；无法继续调用工具。我会基于已有工具结果说明数据限制。";
const TOOL_FALLBACK_MAX_LINES = 12;

const PSEUDO_TOOL_START_MARKERS = [
  { marker: "<｜DSML｜tool_calls", kind: "tool_calls" },
  { marker: "<｜DSML｜tool_call", kind: "tool_calls" },
  { marker: "<｜DSML｜invoke", kind: "invoke" },
  { marker: "<｜DSML｜parameter", kind: "invoke" },
];

const PSEUDO_TOOL_END_MARKERS = {
  tool_calls: ["</｜DSML｜tool_calls>", "</｜DSML｜tool_call"],
  invoke: ["</｜DSML｜invoke>", "</｜DSML｜parameter>", "</｜DSML｜tool_calls>", "</｜DSML｜tool_call"],
};

const MODEL_STOP_TOKEN_FRAGMENTS = new Set(["</s>", "/s>", "s>", "<|im_end|>", "<|endoftext|>"]);

function findPseudoToolStart(text, fromIndex = 0) {
  const candidates = PSEUDO_TOOL_START_MARKERS
    .map(({ marker, kind }) => ({ index: text.indexOf(marker, fromIndex), kind }))
    .filter((candidate) => candidate.index >= 0);
  if (!candidates.length) {
    return null;
  }
  candidates.sort((left, right) => left.index - right.index);
  return candidates[0];
}

function findPseudoToolEnd(text, fromIndex, kind) {
  const markers = PSEUDO_TOOL_END_MARKERS[kind] || PSEUDO_TOOL_END_MARKERS.invoke;
  const candidates = markers
    .map((marker) => ({ index: text.indexOf(marker, fromIndex), marker }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (!candidates.length) {
    return -1;
  }
  const candidate = candidates[0];
  let endIndex = candidate.index + candidate.marker.length;
  if (text[endIndex] === ">") {
    endIndex += 1;
  }
  return endIndex;
}

function longestMarkerPrefixSuffix(text, markers) {
  let longest = "";
  const maxLength = Math.max(0, ...markers.map((marker) => marker.length - 1));
  const start = Math.max(0, text.length - maxLength);
  for (let index = start; index < text.length; index += 1) {
    const suffix = text.slice(index);
    if (suffix.length > longest.length && markers.some((marker) => marker.startsWith(suffix))) {
      longest = suffix;
    }
  }
  return longest;
}

function looksLikePseudoToolPrefix(text) {
  return text.length > 1 && PSEUDO_TOOL_START_MARKERS.some(({ marker }) => marker.startsWith(text));
}

function isModelStopTokenFragment(content) {
  const text = String(content || "").trim();
  return MODEL_STOP_TOKEN_FRAGMENTS.has(text);
}

function buildToolResultFallbackContent(context) {
  const text = String(context || "");
  if (!/# Main agent tool result/i.test(text)) {
    return PSEUDO_TOOL_FALLBACK_CONTENT;
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Tool:/i.test(line))
    .filter((line) => !/^Source query:/i.test(line))
    .filter((line) => !/^drilldown_ref:/i.test(line))
    .filter((line) => !/^[A-Za-z0-9+/=]{120,}$/.test(line));
  const summaryLines = [];
  let insideToolResult = false;

  for (const line of lines) {
    if (/^# Main agent tool result/i.test(line)) {
      insideToolResult = true;
      continue;
    }
    if (!insideToolResult) {
      continue;
    }
    summaryLines.push(line);
    if (summaryLines.length >= TOOL_FALLBACK_MAX_LINES) {
      break;
    }
  }

  if (!summaryLines.length) {
    return PSEUDO_TOOL_FALLBACK_CONTENT;
  }

  return [
    "最终模型没有生成可见回答；以下是已返回工具结果的确定性摘要。",
    "",
    ...summaryLines.map((line) => `- ${line}`),
    "",
    PSEUDO_TOOL_FALLBACK_CONTENT,
  ].join("\n");
}

function sanitizeFinalAnswerContent(content, state) {
  const text = `${state.pendingPseudoToolText || ""}${String(content || "")}`;
  state.pendingPseudoToolText = "";
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    if (state.suppressingPseudoToolCall) {
      const endIndex = findPseudoToolEnd(text, cursor, state.pseudoToolKind);
      state.suppressedPseudoToolCall = true;
      if (endIndex < 0) {
        state.pendingPseudoToolText = longestMarkerPrefixSuffix(
          text.slice(cursor),
          PSEUDO_TOOL_END_MARKERS[state.pseudoToolKind] || PSEUDO_TOOL_END_MARKERS.invoke,
        );
        return output;
      }
      state.suppressingPseudoToolCall = false;
      state.pseudoToolKind = "";
      cursor = endIndex;
      continue;
    }

    const start = findPseudoToolStart(text, cursor);
    if (!start) {
      const remainder = text.slice(cursor);
      state.pendingPseudoToolText = longestMarkerPrefixSuffix(
        remainder,
        PSEUDO_TOOL_START_MARKERS.map(({ marker }) => marker),
      );
      output += remainder.slice(0, remainder.length - state.pendingPseudoToolText.length);
      break;
    }

    output += text.slice(cursor, start.index);
    state.suppressingPseudoToolCall = true;
    state.suppressedPseudoToolCall = true;
    state.pseudoToolKind = start.kind;
    cursor = start.index;
  }

  return output;
}

function flushPendingSanitizedContent(response, state) {
  const pending = state.pendingPseudoToolText || "";
  state.pendingPseudoToolText = "";
  if (!pending) {
    return;
  }
  if (looksLikePseudoToolPrefix(pending)) {
    state.suppressedPseudoToolCall = true;
    return;
  }
  writeSseEvent(response, { choices: [{ delta: { content: pending } }] });
  state.emittedVisibleContent = true;
}

function hasOnlyEmptyContentDelta(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  if (!choices.length) {
    return false;
  }
  return choices.every((choice) => {
    const delta = choice?.delta;
    return delta && Object.keys(delta).length === 1 && delta.content === "";
  });
}

function writePseudoToolFallbackIfNeeded(response, state) {
  const needsFallback = state.suppressedPseudoToolCall || (state.droppedStopTokenFragment && state.hasToolContext);
  if (!needsFallback || state.emittedVisibleContent || state.fallbackEmitted) {
    return;
  }
  writeSseEvent(response, { choices: [{ delta: { content: buildToolResultFallbackContent(state.context) } }] });
  state.emittedVisibleContent = true;
  state.fallbackEmitted = true;
}

function writeSanitizedSseFrame(response, frame, state) {
  const dataLines = String(frame || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) {
    if (frame) {
      response.write(`${frame}\n\n`);
    }
    return;
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    flushPendingSanitizedContent(response, state);
    writePseudoToolFallbackIfNeeded(response, state);
    response.write("data: [DONE]\n\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    const sanitized = sanitizeFinalAnswerContent(data, state);
    if (sanitized && !isModelStopTokenFragment(sanitized)) {
      response.write(`data: ${sanitized}\n\n`);
      state.emittedVisibleContent = true;
    } else if (sanitized) {
      state.droppedStopTokenFragment = true;
    }
    return;
  }

  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    if (typeof choice?.delta?.content !== "string") {
      continue;
    }
    const sanitized = sanitizeFinalAnswerContent(choice.delta.content, state);
    if (isModelStopTokenFragment(sanitized)) {
      choice.delta.content = "";
      state.droppedStopTokenFragment = true;
      continue;
    }
    choice.delta.content = sanitized;
    if (sanitized) {
      state.emittedVisibleContent = true;
    }
  }

  if (!hasOnlyEmptyContentDelta(payload)) {
    writeSseEvent(response, payload);
  }
}

export async function requestCompanyChatCompletion({
  messages,
  model,
  context,
  tools,
  toolChoice,
  imageOcrRunner,
  documentTextRunner,
}) {
  const config = resolveChatModelConfig(model || "", process.env);
  if (!config.credential) {
    throw new Error(
      "Company model credentials are not configured. Set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY.",
    );
  }

  const documentExpandedMessages = await expandMessagesWithDocumentText(messages, process.env, { documentTextRunner });
  const preparedMessages = await expandImageMessagesWithOcr(documentExpandedMessages, process.env, { imageOcrRunner });
  const mergedMessages = buildMergedMessages(compactChatMessages(preparedMessages), context);

  const requestConfig = buildChatCompletionRequest({
    selectedModel: config.model,
    messages: mergedMessages,
    env: process.env,
    tools,
    toolChoice,
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
  const message = payload?.choices?.[0]?.message || {};
  const content = normalizeAssistantContent(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!content && toolCalls.length === 0) {
    throw new Error("Chat model returned empty content");
  }

  return {
    content,
    toolCalls,
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
  const mergedMessages = buildMergedMessages(compactChatMessages(preparedMessages), context);
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
    const decoder = new TextDecoder();
    const sanitizerState = {
      suppressingPseudoToolCall: false,
      suppressedPseudoToolCall: false,
      emittedVisibleContent: false,
      fallbackEmitted: false,
      droppedStopTokenFragment: false,
      hasToolContext: /# Main agent tool result/i.test(String(context || "")),
      context: String(context || ""),
      pseudoToolKind: "",
      pendingPseudoToolText: "",
    };
    let sseBuffer = "";

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
        sseBuffer += decoder.decode(value, { stream: true });
        let frameBoundary = sseBuffer.indexOf("\n\n");
        while (frameBoundary >= 0) {
          const frame = sseBuffer.slice(0, frameBoundary);
          sseBuffer = sseBuffer.slice(frameBoundary + 2);
          writeSanitizedSseFrame(response, frame, sanitizerState);
          frameBoundary = sseBuffer.indexOf("\n\n");
        }
      }
    }

    sseBuffer += decoder.decode();
    if (sseBuffer.trim()) {
      writeSanitizedSseFrame(response, sseBuffer.trimEnd(), sanitizerState);
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
