import Ajv2020 from "ajv/dist/2020.js";

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function anySignal(signals) {
  const activeSignals = signals.filter(Boolean);
  if (typeof AbortSignal.any === "function") return AbortSignal.any(activeSignals);
  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal?.reason || "aborted");
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function modelError(code, message, retryable, cause, extra = {}) {
  return Object.assign(new Error(message, { cause }), { code, retryable, ...extra });
}

function normalizeFinishReason(reason) {
  return ({
    tool_calls: "tool_calls",
    stop: "stop",
    length: "length",
    content_filter: "content_filter",
    cancelled: "cancelled",
  })[reason] || "error";
}

function usageFromProvider(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number.isInteger(usage.input_tokens) ? usage.input_tokens : usage.prompt_tokens;
  const outputTokens = Number.isInteger(usage.output_tokens) ? usage.output_tokens : usage.completion_tokens;
  if (!Number.isInteger(inputTokens) && !Number.isInteger(outputTokens)) return undefined;
  return {
    inputTokens: Number.isInteger(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isInteger(outputTokens) ? outputTokens : 0,
  };
}

function stripReasoningText(text) {
  return String(text || "").replace(THINK_RE, "").trim();
}

function normalizePublicContent(content) {
  if (typeof content === "string") return stripReasoningText(content);
  if (!Array.isArray(content)) return "";
  return stripReasoningText(content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    if (part && typeof part === "object" && part.type === "text" && typeof part.content === "string") return part.content;
    return "";
  }).filter(Boolean).join("\n"));
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => ({
    toolCallId: String(call?.id || call?.toolCallId || ""),
    name: String(call?.function?.name || call?.name || ""),
    argumentsText: String(call?.function?.arguments || call?.argumentsText || ""),
  })).filter((call) => call.toolCallId && call.name);
}

function toProviderMessage(message) {
  if (message.role === "assistant") {
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    return {
      role: "assistant",
      ...(message.content ? { content: message.content } : { content: null }),
      ...(toolCalls.length ? {
        tool_calls: toolCalls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: { name: call.name, arguments: call.argumentsText || "{}" },
        })),
      } : {}),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function appendJsonPrompt(messages, outputSchema) {
  if (!outputSchema) return messages;
  return [
    ...messages,
    {
      role: "system",
      content: `Return only JSON that validates against this JSON Schema. Do not include markdown or commentary.\n${JSON.stringify(outputSchema)}`,
    },
  ];
}

function buildProviderBody(record, request, { stream = false, repair = false } = {}) {
  const baseMessages = request.messages.map(toProviderMessage);
  const messages = request.outputSchema && record.capabilities.structuredOutputMode === "json_prompt"
    ? appendJsonPrompt(baseMessages, request.outputSchema)
    : baseMessages;
  const body = {
    model: record.id,
    messages: repair
      ? [
          ...baseMessages,
          {
            role: "system",
            content: `Repair the previous response. Return only JSON that validates against this JSON Schema.\n${JSON.stringify(request.outputSchema)}`,
          },
        ]
      : messages,
    temperature: request.temperature,
    stream,
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...(request.toolChoice == null ? {} : { tool_choice: request.toolChoice }),
    ...(record.capabilities.parallelToolCalls || request.allowParallelToolCalls ? { parallel_tool_calls: Boolean(request.allowParallelToolCalls) } : { parallel_tool_calls: false }),
  };
  if (record.requestDialect === "openai_chat_completions") {
    body.max_tokens = request.maxOutputTokens;
    if (request.outputSchema && record.capabilities.structuredOutputMode === "native_json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: "agent_response", schema: request.outputSchema } };
    }
  } else {
    body.max_token_length = request.maxOutputTokens;
    if (request.outputSchema && record.capabilities.structuredOutputMode === "native_json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: "agent_response", schema: request.outputSchema } };
    }
  }
  return body;
}

async function assertNotCancelled(context) {
  if (context?.signal?.aborted || await context?.isCancellationRequested?.()) {
    throw modelError("MODEL_CANCELLED", "Model request cancelled", false, undefined, { status: "cancelled" });
  }
}

function classifyFetchError(error, signal, timeoutController) {
  if (signal?.aborted || timeoutController?.signal?.aborted) {
    const timeout = timeoutController?.signal?.aborted && !signal?.aborted;
    return modelError(timeout ? "MODEL_TIMEOUT" : "MODEL_CANCELLED", timeout ? "Model request timed out" : "Model request cancelled", timeout, error, { status: timeout ? "timeout" : "cancelled" });
  }
  return modelError("MODEL_NETWORK_ERROR", "Model network request failed", true, error);
}

async function executeWithRetry(record, context, operation) {
  const attempts = record.capabilities.retryPolicy?.maxAttempts || 1;
  const backoffMs = record.capabilities.retryPolicy?.backoffMs || 0;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await assertNotCancelled(context);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt >= attempts) throw error;
      if (backoffMs > 0) await wait(backoffMs);
    }
  }
  throw lastError;
}

async function fetchJson({ record, fetchImpl, request, context, stream = false, repair = false }) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort("timeout"), record.capabilities.timeoutMs);
  const signal = anySignal([context?.signal, timeoutController.signal]);
  try {
    const response = await fetchImpl(record.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `${record.authScheme} ${record.credential}`.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildProviderBody(record, request, { stream, repair })),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP.has(response.status);
      throw modelError(`MODEL_HTTP_${response.status}`, `Model request failed (${response.status}): ${text || response.statusText}`, retryable);
    }
    return response;
  } catch (error) {
    if (error?.code?.startsWith?.("MODEL_HTTP_")) throw error;
    throw classifyFetchError(error, context?.signal, timeoutController);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeResponsePayload(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const text = normalizePublicContent(message.content);
  const toolCalls = normalizeToolCalls(message.tool_calls);
  if (!text && toolCalls.length === 0) throw modelError("MODEL_EMPTY_RESPONSE", "Model returned empty content", false);
  return {
    text,
    toolCalls,
    finishReason: normalizeFinishReason(choice.finish_reason),
    usage: usageFromProvider(payload?.usage),
    providerRequestId: payload?.id || payload?.request_id,
  };
}

function validateStructuredOutput(outputSchema, text) {
  if (!outputSchema) return;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw modelError("MODEL_STRUCTURED_OUTPUT_INVALID", "Model structured output is not valid JSON", false, error);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false, removeAdditional: false });
  const validate = ajv.compile(outputSchema);
  if (!validate(value)) {
    throw modelError("MODEL_STRUCTURED_OUTPUT_INVALID", ajv.errorsText(validate.errors), false);
  }
}

function parseSseFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const lfIndex = rest.indexOf("\n\n");
    const crlfIndex = rest.indexOf("\r\n\r\n");
    const candidates = [lfIndex, crlfIndex].filter((index) => index >= 0);
    if (candidates.length === 0) break;
    const index = Math.min(...candidates);
    const separatorLength = rest.startsWith("\r\n\r\n", index) ? 4 : 2;
    frames.push(rest.slice(0, index));
    rest = rest.slice(index + separatorLength);
  }
  return { frames, rest };
}

function dataFromFrame(frame) {
  return frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function applyToolDeltas(rawCalls, toolDeltas) {
  const emitted = [];
  for (const rawCall of rawCalls || []) {
    const index = Number.isInteger(rawCall.index) ? rawCall.index : 0;
    const existing = toolDeltas.get(index) || { toolCallId: "", name: "", argumentsText: "" };
    const toolCallId = rawCall.id || existing.toolCallId;
    if (!toolCallId) throw modelError("MODEL_TOOL_CALL_ID_MISSING", "Streaming tool call is missing an id", false);
    const name = rawCall.function?.name || existing.name;
    const argumentsDelta = rawCall.function?.arguments || "";
    const next = { toolCallId, name, argumentsText: `${existing.argumentsText}${argumentsDelta}` };
    toolDeltas.set(index, next);
    if (argumentsDelta || rawCall.function?.name) {
      emitted.push({ type: "tool_call_delta", toolCallId, ...(rawCall.function?.name ? { name } : {}), argumentsDelta });
    }
  }
  return emitted;
}

export function createInternalModelAdapter({ registry, fetchImpl = globalThis.fetch }) {
  async function invokeOnce(request, context, { repair = false } = {}) {
    const record = registry.require(request.modelId, { purpose: request.purpose });
    const response = await executeWithRetry(record, context, async () => fetchJson({ record, fetchImpl, request, context, repair }));
    const payload = await response.json();
    const normalized = normalizeResponsePayload(payload);
    await assertNotCancelled(context);
    return normalized;
  }

  async function invoke(request, context = {}) {
    try {
      const response = await invokeOnce(request, context);
      validateStructuredOutput(request.outputSchema, response.text);
      return response;
    } catch (error) {
      if (error?.code !== "MODEL_STRUCTURED_OUTPUT_INVALID" || !request.outputSchema) throw error;
      const repaired = await invokeOnce({ ...request, purpose: "repair" }, context, { repair: true });
      validateStructuredOutput(request.outputSchema, repaired.text);
      return repaired;
    }
  }

  async function* stream(request, context = {}) {
    const record = registry.require(request.modelId, { purpose: request.purpose });
    await assertNotCancelled(context);
    const response = await executeWithRetry(record, context, async () => fetchJson({ record, fetchImpl, request, context, stream: true }));
    if (!response.body) throw modelError("MODEL_STREAM_BODY_MISSING", "Model did not return a stream body", false);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolDeltas = new Map();
    let buffer = "";
    let bufferedText = "";
    let finishReason = "stop";
    let usage;
    let completed = false;

    const complete = () => ({
      type: "completed",
      response: {
        text: bufferedText,
        toolCalls: [...toolDeltas.values()].filter((call) => call.toolCallId && call.name).map((call) => ({ toolCallId: call.toolCallId, name: call.name, argumentsText: call.argumentsText })),
        finishReason,
        usage,
        providerRequestId: response.headers.get("x-request-id") || undefined,
      },
    });

    try {
      while (true) {
        await assertNotCancelled(context);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const data = dataFromFrame(frame);
          if (!data) continue;
          if (data === "[DONE]") {
            completed = true;
            yield complete();
            continue;
          }
          const payload = JSON.parse(data);
          const chunkUsage = usageFromProvider(payload.usage);
          if (chunkUsage) {
            usage = chunkUsage;
            yield { type: "usage", ...chunkUsage };
          }
          const choice = payload?.choices?.[0] || {};
          if (choice.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
          const delta = choice.delta || {};
          const text = normalizePublicContent(delta.content);
          if (text) {
            bufferedText += text;
            yield { type: "content_delta", text };
          }
          for (const event of applyToolDeltas(delta.tool_calls, toolDeltas)) yield event;
        }
      }
      buffer += decoder.decode();
      if (!completed) yield complete();
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
  }

  return Object.freeze({
    capabilities: (modelId) => registry.require(modelId).capabilities,
    invoke,
    stream,
  });
}