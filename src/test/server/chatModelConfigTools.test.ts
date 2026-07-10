import { describe, expect, it } from "vitest";

import { buildChatCompletionRequest } from "../../../server/chatModelConfig.mjs";

const sampleTools = [
  {
    type: "function",
    function: {
      name: "get_current_status",
      description: "Return the current dashboard status.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

const sampleToolChoice = {
  type: "function",
  function: { name: "get_current_status" },
};

describe("buildChatCompletionRequest tool calling options", () => {
  it("passes OpenAI-compatible tools through to internal company endpoints", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Use the tool." }],
      env: {
        DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      },
      tools: sampleTools,
      toolChoice: sampleToolChoice,
    });

    expect(request.config.usesInternalEndpoint).toBe(true);
    expect(request.body.tools).toEqual(sampleTools);
    expect(request.body.tool_choice).toEqual(sampleToolChoice);
  });

  it("passes OpenAI-compatible tools through to external chat completion endpoints", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "deepseek-chat",
      messages: [{ role: "user", content: "Use the tool." }],
      env: {
        DUPSEARCH_CHAT_MODEL_ENDPOINTS: "{}",
        DUPSEARCH_CHAT_API_KEY: "test-api-key",
        DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
      },
      tools: sampleTools,
      toolChoice: "auto",
    });

    expect(request.config.usesInternalEndpoint).toBe(false);
    expect(request.body.tools).toEqual(sampleTools);
    expect(request.body.tool_choice).toBe("auto");
  });

  it("omits tool fields when no tools are provided", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "deepseek-v4-flash",
      messages: [{ role: "user", content: "plain chat" }],
      env: {
        DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      },
    });

    expect(request.body).not.toHaveProperty("tools");
    expect(request.body).not.toHaveProperty("tool_choice");
  });
});