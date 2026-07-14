import { describe, expect, it } from "vitest";

import {
  buildChatCompletionRequest,
  getChatModelOptions,
  resolveChatModelConfig,
} from "../../../server/chatModelConfig.mjs";

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
  it("keeps legacy Duplicate endpoint selection and max_token_length body", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      env: { DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code" },
    });

    expect(request.config.usesInternalEndpoint).toBe(true);
    expect(request.url).toContain("/chat/completions");
    expect(request.headers.authorization).toBe("ACCESSCODE test-access-code");
    expect(request.body.max_token_length).toBe(2048);
    expect(request.body).not.toHaveProperty("max_tokens");
  });

  it("keeps legacy fallback API-key mode for unknown models", () => {
    const config = resolveChatModelConfig("custom-model", {
      DUPSEARCH_CHAT_MODEL_ENDPOINTS: "{}",
      DUPSEARCH_CHAT_API_KEY: "test-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
    });
    const request = buildChatCompletionRequest({
      selectedModel: "custom-model",
      messages: [{ role: "user", content: "hello" }],
      env: {
        DUPSEARCH_CHAT_MODEL_ENDPOINTS: "{}",
        DUPSEARCH_CHAT_API_KEY: "test-api-key",
        DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
      },
    });

    expect(config).toMatchObject({ model: "custom-model", usesInternalEndpoint: false, authScheme: "Bearer" });
    expect(request.url).toBe("https://example.test/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-api-key");
    expect(request.body.max_tokens).toBe(900);
  });

  it("keeps legacy model option ordering and default fallback", () => {
    expect(getChatModelOptions({ DUPSEARCH_CHAT_MODEL_OPTIONS: "bacon,deepseek-v4-flash,bacon" }).slice(0, 4)).toEqual([
      "bacon",
      "deepseek-v4-flash",
      "qwen3.5-397b-a17b",
      "glm-5",
    ]);
  });

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