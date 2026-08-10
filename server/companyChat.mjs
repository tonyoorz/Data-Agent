import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";
import { compactChatMessages } from "./chatMessageBudget.mjs";
import { expandMessagesWithDocumentText } from "./documentText.mjs";
import { expandImageMessagesWithOcr } from "./imageOcr.mjs";
import { validateAnswerTextCitations } from "./answerValidator.mjs";
import { evaluateSemanticEvidence } from "./mainAgentEvidence.mjs";

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
- Do not make causal claims unless the supplied evidence explicitly supports causality; describe observed associations and limitations instead.

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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function chatResilienceOptions(env = process.env) {
  return {
    maxAttempts: positiveInteger(env.DUPSEARCH_CHAT_MAX_ATTEMPTS, 2),
    timeoutMs: positiveInteger(env.DUPSEARCH_CHAT_TIMEOUT_MS, 30000),
    retryDelayMs: nonNegativeInteger(env.DUPSEARCH_CHAT_RETRY_DELAY_MS, 250),
  };
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error) {
  return error?.name === "AbortError" || error?.retryable === true || /fetch failed|network|timeout/i.test(String(error?.message || ""));
}

function waitForRetry(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithResilience(url, init, { env = process.env } = {}) {
  const { maxAttempts, timeoutMs, retryDelayMs } = chatResilienceOptions(env);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
      if (response.ok || !isRetryableStatus(response.status) || attempt >= maxAttempts) return response;
      const text = await response.text().catch(() => "");
      lastError = new Error(`Chat request failed (${response.status}): ${text || response.statusText}`);
      lastError.status = response.status;
      lastError.retryable = true;
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt >= maxAttempts) throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await waitForRetry(retryDelayMs);
  }
  throw lastError || new Error("Chat request failed after retries");
}

const PSEUDO_TOOL_FALLBACK_CONTENT = "工具调用阶段已结束；无法继续调用工具。我会基于已有工具结果说明数据限制。";
export const GOVERNED_EVIDENCE_UNAVAILABLE_CONTENT = "受治理证据不可用，因此本次不会发布数据事实或结论。请重试或缩小查询范围。";
const DEFAULT_ANSWER_RELEASE_MAX_BYTES = 256 * 1024;
const DEFAULT_ANSWER_RELEASE_TIMEOUT_MS = 30_000;
const ANSWER_RELEASE_CHUNK_CHARACTERS = 120;
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

const MODEL_STOP_TOKEN_MARKERS = ["</s>", "/s>", "s>", "<|im_end|>", "<|endoftext|>"];
const MODEL_STOP_TOKEN_FRAGMENTS = new Set(MODEL_STOP_TOKEN_MARKERS);

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

function looksLikeModelStopTokenPrefix(text) {
  return text.length > 0 && MODEL_STOP_TOKEN_MARKERS.some((marker) => marker.startsWith(text));
}

function stripModelStopTokenFragments(content, state) {
  let text = `${state.pendingStopTokenText || ""}${String(content || "")}`;
  state.pendingStopTokenText = "";
  if (!text) {
    return "";
  }

  if (isModelStopTokenFragment(text)) {
    state.droppedStopTokenFragment = true;
    return "";
  }

  for (const marker of MODEL_STOP_TOKEN_MARKERS.filter((value) => value !== "s>")) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex >= 0) {
      state.droppedStopTokenFragment = true;
      text = `${text.slice(0, markerIndex)}${text.slice(markerIndex + marker.length)}`;
    }
  }

  const trailingStopTokenPrefix = longestMarkerPrefixSuffix(text, MODEL_STOP_TOKEN_MARKERS);
  if (trailingStopTokenPrefix) {
    state.pendingStopTokenText = trailingStopTokenPrefix;
    text = text.slice(0, text.length - trailingStopTokenPrefix.length);
  }

  return text;
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

function addVisibleContent(response, state, content) {
  const text = String(content || "");
  if (!text || state.releaseViolation) {
    return;
  }
  if (state.releaseRequired) {
    const nextBytes = state.releaseBytes + Buffer.byteLength(text, "utf8");
    if (nextBytes > state.releaseMaxBytes) {
      state.releaseViolation = "ANSWER_RELEASE_BUFFER_LIMIT_EXCEEDED";
      state.visibleContentParts = [];
      state.releaseBytes = 0;
      state.emittedVisibleContent = false;
      return;
    }
    state.releaseBytes = nextBytes;
    state.visibleContentParts.push(text);
    state.emittedVisibleContent = true;
    return;
  }
  writeSseEvent(response, { choices: [{ delta: { content: text } }] });
  state.visibleContentParts.push(text);
  state.emittedVisibleContent = true;
}

function flushPendingSanitizedContent(response, state) {
  const pending = state.pendingPseudoToolText || "";
  state.pendingPseudoToolText = "";
  if (pending) {
    if (looksLikePseudoToolPrefix(pending)) {
      state.suppressedPseudoToolCall = true;
    } else {
      addVisibleContent(response, state, pending);
    }
  }

  const pendingStopToken = state.pendingStopTokenText || "";
  state.pendingStopTokenText = "";
  if (!pendingStopToken) {
    return;
  }
  if (isModelStopTokenFragment(pendingStopToken) || (state.hasToolContext && looksLikeModelStopTokenPrefix(pendingStopToken))) {
    state.droppedStopTokenFragment = true;
    return;
  }
  addVisibleContent(response, state, pendingStopToken);
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
  const needsFallback = state.suppressedPseudoToolCall || (state.hasToolContext && (state.droppedStopTokenFragment || !state.emittedVisibleContent));
  if (!needsFallback || state.emittedVisibleContent || state.fallbackEmitted) {
    return;
  }
  const fallbackContent = buildToolResultFallbackContent(state.context);
  addVisibleContent(response, state, fallbackContent);
  state.fallbackEmitted = true;
}

function computeAnswerValidation(state) {
  if (state.releaseViolation) {
    return { valid: false, violations: [state.releaseViolation] };
  }
  const violations = [];
  if (state.releaseRequired) {
    let registryConstraintAvailable = false;
    try {
      registryConstraintAvailable = Boolean(state.answerValidation?.registry?.getConstraint?.("answer.claim_evidence_binding"));
    } catch {
      registryConstraintAvailable = false;
    }
    if (!registryConstraintAvailable) {
      violations.push("ANSWER_VALIDATION_REGISTRY_UNAVAILABLE");
    }
    const evidenceGate = evaluateSemanticEvidence(state.answerValidation?.evidence, {
      expectedActorScopeHash: state.answerValidation?.expectedActorScopeHash,
      expectedSourceRevisionIds: state.answerValidation?.expectedSourceRevisionIds,
      requireReleaseBinding: true,
    });
    if (evidenceGate.status === "not_required") {
      violations.push("SEMANTIC_CLAIM_EVIDENCE_MISSING");
    }
    violations.push(...evidenceGate.violations);
  }
  const citationValidation = validateAnswerTextCitations({
    text: (state.visibleContentParts || []).join(""),
    evidence: state.answerValidation?.evidence,
    registry: state.answerValidation?.registry,
  });
  violations.push(...citationValidation.violations);
  const uniqueViolations = [...new Set(violations)];
  return { valid: uniqueViolations.length === 0, violations: uniqueViolations };
}

function emitAnswerValidation(response, state, validation) {
  writeSseEvent(response, { type: "answer-validation", ...validation });
  try {
    state.onAnswerValidation?.(validation);
  } catch {
    // Validation observers must not interrupt answer streaming.
  }
}

function writeAnswerValidationIfNeeded(response, state) {
  if (!state.answerValidation || state.answerValidationEmitted) {
    return null;
  }
  state.answerValidationEmitted = true;
  const validation = computeAnswerValidation(state);
  emitAnswerValidation(response, state, validation);
  return validation;
}

function writeContentChunks(response, content) {
  const chunks = String(content || "").match(new RegExp(`.{1,${ANSWER_RELEASE_CHUNK_CHARACTERS}}`, "gs")) || [String(content || "")];
  for (const chunk of chunks) {
    writeSseEvent(response, { choices: [{ delta: { content: chunk } }] });
  }
}

function finalizeAnswerRelease(response, state) {
  if (state.terminalEmitted) {
    return;
  }
  flushPendingSanitizedContent(response, state);
  writePseudoToolFallbackIfNeeded(response, state);
  const validation = computeAnswerValidation(state);
  state.answerValidationEmitted = true;
  if (validation.valid) {
    writeContentChunks(response, state.visibleContentParts.join(""));
  } else {
    writeContentChunks(response, GOVERNED_EVIDENCE_UNAVAILABLE_CONTENT);
  }
  emitAnswerValidation(response, state, validation);
  response.write("data: [DONE]\n\n");
  state.terminalEmitted = true;
}

function writeSanitizedSseFrame(response, frame, state) {
  if (state.terminalEmitted) {
    return true;
  }
  const dataLines = String(frame || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) {
    if (frame && !state.releaseRequired) {
      response.write(`${frame}\n\n`);
    }
    return false;
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    if (state.releaseRequired) {
      finalizeAnswerRelease(response, state);
    } else {
      flushPendingSanitizedContent(response, state);
      writePseudoToolFallbackIfNeeded(response, state);
      writeAnswerValidationIfNeeded(response, state);
      response.write("data: [DONE]\n\n");
      state.terminalEmitted = true;
    }
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    const sanitized = stripModelStopTokenFragments(sanitizeFinalAnswerContent(data, state), state);
    if (sanitized) {
      addVisibleContent(response, state, sanitized);
    }
    return false;
  }

  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    if (typeof choice?.delta?.content !== "string") {
      continue;
    }
    const sanitized = stripModelStopTokenFragments(sanitizeFinalAnswerContent(choice.delta.content, state), state);
    if (!sanitized && state.droppedStopTokenFragment) {
      choice.delta.content = "";
      continue;
    }
    choice.delta.content = sanitized;
    if (sanitized) {
      if (state.releaseRequired) {
        addVisibleContent(response, state, sanitized);
      } else {
        state.visibleContentParts.push(sanitized);
        state.emittedVisibleContent = true;
      }
    }
  }

  if (!state.releaseRequired && !hasOnlyEmptyContentDelta(payload)) {
    writeSseEvent(response, payload);
  }
  return false;
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

  const response = await fetchWithResilience(requestConfig.url, {
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
  answerValidation,
  onAnswerValidation,
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
    const upstreamResponse = await fetchWithResilience(requestConfig.url, {
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
    const releaseRequired = answerValidation?.releaseRequired === true;
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
      pendingStopTokenText: "",
      visibleContentParts: [],
      answerValidation,
      answerValidationEmitted: false,
      onAnswerValidation,
      releaseRequired,
      releaseMaxBytes: positiveInteger(process.env.VIZION_ANSWER_RELEASE_MAX_BYTES, DEFAULT_ANSWER_RELEASE_MAX_BYTES),
      releaseFrameMaxBytes: positiveInteger(process.env.VIZION_ANSWER_RELEASE_MAX_BYTES, DEFAULT_ANSWER_RELEASE_MAX_BYTES) + 64 * 1024,
      releaseBytes: 0,
      releaseViolation: "",
      terminalEmitted: false,
    };
    const releaseDeadline = releaseRequired
      ? Date.now() + positiveInteger(process.env.VIZION_ANSWER_RELEASE_TIMEOUT_MS, DEFAULT_ANSWER_RELEASE_TIMEOUT_MS)
      : null;
    let sseBuffer = "";
    let stopReading = false;

    while (!stopReading) {
      let readResult;
      if (releaseDeadline) {
        const remainingMs = releaseDeadline - Date.now();
        if (remainingMs <= 0) {
          sanitizerState.releaseViolation = "ANSWER_RELEASE_TIMEOUT";
          break;
        }
        let timeout;
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise((resolve) => {
              timeout = setTimeout(() => resolve({ releaseTimedOut: true }), remainingMs);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        if (readResult?.releaseTimedOut) {
          sanitizerState.releaseViolation = "ANSWER_RELEASE_TIMEOUT";
          break;
        }
      } else {
        readResult = await reader.read();
      }
      const { done, value } = readResult;
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
        if (releaseRequired && Buffer.byteLength(sseBuffer, "utf8") > sanitizerState.releaseFrameMaxBytes) {
          sanitizerState.releaseViolation = "ANSWER_RELEASE_BUFFER_LIMIT_EXCEEDED";
          sseBuffer = "";
          stopReading = true;
          continue;
        }
        let frameBoundary = sseBuffer.indexOf("\n\n");
        while (frameBoundary >= 0) {
          const frame = sseBuffer.slice(0, frameBoundary);
          sseBuffer = sseBuffer.slice(frameBoundary + 2);
          if (writeSanitizedSseFrame(response, frame, sanitizerState)) {
            stopReading = true;
            break;
          }
          if (sanitizerState.releaseViolation) {
            stopReading = true;
            break;
          }
          frameBoundary = sseBuffer.indexOf("\n\n");
        }
      }
    }

    if (stopReading || sanitizerState.releaseViolation) {
      await reader.cancel().catch(() => {});
    }
    sseBuffer += decoder.decode();
    if (!sanitizerState.terminalEmitted && !sanitizerState.releaseViolation && sseBuffer.trim()) {
      writeSanitizedSseFrame(response, sseBuffer.trimEnd(), sanitizerState);
    }

    if (!sanitizerState.terminalEmitted) {
      if (releaseRequired) {
        finalizeAnswerRelease(response, sanitizerState);
      } else {
        flushPendingSanitizedContent(response, sanitizerState);
        writePseudoToolFallbackIfNeeded(response, sanitizerState);
        writeAnswerValidationIfNeeded(response, sanitizerState);
        response.write("data: [DONE]\n\n");
        sanitizerState.terminalEmitted = true;
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

export function writeGovernedEvidenceBlockResponse(response, violations = []) {
  ensureSseHeaders(response);
  const validation = {
    valid: false,
    violations: [...new Set((Array.isArray(violations) ? violations : []).map((value) => String(value || "").trim()).filter(Boolean))],
  };
  if (!validation.violations.length) {
    validation.violations.push("SEMANTIC_EVIDENCE_GATE_BLOCKED");
  }
  writeContentChunks(response, GOVERNED_EVIDENCE_UNAVAILABLE_CONTENT);
  writeSseEvent(response, { type: "answer-validation", ...validation });
  response.write("data: [DONE]\n\n");
  response.end();
  return validation;
}
