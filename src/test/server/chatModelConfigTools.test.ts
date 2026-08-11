import { describe, expect, it } from "vitest";

import { buildChatCompletionRequest, resolveChatModelConfig } from "../../../server/chatModelConfig.mjs";

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
  it("requests streamed usage metadata for OpenAI-compatible chat streams", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "deepseek-v4-flash",
      messages: [{ role: "user", content: "stream with usage" }],
      env: {
        DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      },
      stream: true,
    });

    expect(request.body.stream_options).toEqual({ include_usage: true });
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
        DUPSEARCH_CHAT_API_KEY: "test-api-key",
        DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
        DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-chat",
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

  it.each([
    {
      DUPSEARCH_CHAT_API_KEY: "secret",
      DUPSEARCH_CHAT_API_BASE: "http://model.example.test/v1",
      DUPSEARCH_CHAT_MODEL_OPTIONS: "custom",
    },
    {
      DUPSEARCH_CHAT_API_KEY: "secret",
      DUPSEARCH_CHAT_API_BASE: "https://model.example.test/v1?token=secret",
      DUPSEARCH_CHAT_MODEL_OPTIONS: "custom",
    },
    {
      DUPSEARCH_CHAT_ACCESS_CODE: "secret",
      DUPSEARCH_CHAT_MODEL_ENDPOINTS: JSON.stringify({ custom: "http://model.example.test/chat" }),
      DUPSEARCH_CHAT_MODEL_OPTIONS: "custom",
    },
  ])("rejects remote plaintext model endpoints", (env) => {
    expect(() => buildChatCompletionRequest({
      selectedModel: "custom",
      messages: [{ role: "user", content: "hello" }],
      env,
    })).toThrow("CHAT_MODEL_ENDPOINT_INVALID");
  });

  it("does not treat the generic API_KEY variable as a model credential", () => {
    const request = buildChatCompletionRequest({
      selectedModel: "custom",
      messages: [{ role: "user", content: "hello" }],
      env: {
        API_KEY: "unrelated-secret",
        DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
        DUPSEARCH_CHAT_MODEL_OPTIONS: "custom",
      },
    });

    expect(request.config.credential).toBe("");
    expect(request.headers).not.toHaveProperty("Authorization");
  });

  it("uses the documented API-key fallback for the default model when no access code is set", () => {
    const config = resolveChatModelConfig("deepseek-v4-flash", {
      DUPSEARCH_CHAT_API_KEY: "test-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
    });

    expect(config).toMatchObject({
      usesInternalEndpoint: false,
      credential: "test-api-key",
      baseUrl: "https://example.test/v1",
    });
  });

  it("gives an explicit company access code precedence over the API-key fallback", () => {
    const config = resolveChatModelConfig("deepseek-v4-flash", {
      DUPSEARCH_CHAT_ACCESS_CODE: "company-access-code",
      DUPSEARCH_CHAT_API_KEY: "external-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
    });

    expect(config).toMatchObject({
      usesInternalEndpoint: true,
      credential: "company-access-code",
      baseUrl: "",
    });
  });

  it.each([
    "not-json",
    "",
    "   ",
    "[]",
    "{}",
    JSON.stringify({ custom: "" }),
  ])("rejects an explicitly invalid endpoint map instead of falling back (%s)", (endpointMap) => {
    expect(() => resolveChatModelConfig("custom", {
      DUPSEARCH_CHAT_MODEL_ENDPOINTS: endpointMap,
      DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      DUPSEARCH_CHAT_MODEL_OPTIONS: "custom",
    })).toThrow("CHAT_MODEL_ENDPOINT_INVALID");
  });

  it("rejects a client-selected model outside the server allowlist", () => {
    expect(() => buildChatCompletionRequest({
      selectedModel: "high-cost-unapproved-model",
      messages: [{ role: "user", content: "hello" }],
      env: {
        DUPSEARCH_CHAT_API_KEY: "test-api-key",
        DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
        DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-v4-flash",
      },
    })).toThrow("CHAT_MODEL_NOT_ALLOWED");
  });

  it("treats an explicit model options list as a strict server allowlist", () => {
    expect(resolveChatModelConfig("approved-model", {
      DUPSEARCH_CHAT_API_KEY: "test-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
      DUPSEARCH_CHAT_MODEL_OPTIONS: "approved-model",
    }).model).toBe("approved-model");
    expect(() => resolveChatModelConfig("deepseek-v4-flash", {
      DUPSEARCH_CHAT_API_KEY: "test-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
      DUPSEARCH_CHAT_MODEL_OPTIONS: "approved-model",
    })).toThrow("CHAT_MODEL_NOT_ALLOWED");
  });

  it.each(["", "   ", ",", " , , "])("fails closed on an explicitly empty server model allowlist (%j)", (value) => {
    expect(() => resolveChatModelConfig("", {
      DUPSEARCH_CHAT_MODEL_OPTIONS: value,
      DUPSEARCH_CHAT_API_KEY: "test-api-key",
      DUPSEARCH_CHAT_API_BASE: "https://example.test/v1",
    })).toThrow("CHAT_MODEL_OPTIONS_INVALID");
  });
});
