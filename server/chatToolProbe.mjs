import { buildChatCompletionRequest, getDefaultChatModel } from "./chatModelConfig.mjs";

export const TOOL_PROBE_FUNCTION_NAME = "get_probe_status";

export const TOOL_PROBE_TOOLS = [
  {
    type: "function",
    function: {
      name: TOOL_PROBE_FUNCTION_NAME,
      description: "Return a minimal status object for tool-calling capability checks.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the probe is being run.",
          },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

export const TOOL_PROBE_MESSAGES = [
  {
    role: "user",
    content: "Call get_probe_status with reason=tool-capability-check.",
  },
];

export function buildToolCallingProbeRequest({ model, env = process.env } = {}) {
  return buildChatCompletionRequest({
    selectedModel: model || getDefaultChatModel(env),
    messages: TOOL_PROBE_MESSAGES,
    env,
    tools: TOOL_PROBE_TOOLS,
    toolChoice: {
      type: "function",
      function: { name: TOOL_PROBE_FUNCTION_NAME },
    },
  });
}

function normalizeContentPreview(content) {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

  return "";
}

export function classifyToolCallingProbePayload(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const firstToolName = toolCalls[0]?.function?.name || message.function_call?.name || "";
  const toolCallCount = toolCalls.length || (message.function_call ? 1 : 0);

  return {
    supported: toolCallCount > 0,
    toolCallCount,
    firstToolName,
    finishReason: payload?.choices?.[0]?.finish_reason || "",
    contentPreview: normalizeContentPreview(message.content),
  };
}