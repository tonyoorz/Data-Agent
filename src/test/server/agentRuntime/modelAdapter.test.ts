import { describe, expect, it, vi } from "vitest";
import { createInternalModelAdapter } from "../../../../server/agentRuntime/modelAdapter.mjs";

const capability = {
  nativeToolCalling: true,
  structuredOutputMode: "json_prompt",
  streaming: true,
  parallelToolCalls: false,
  contextWindow: 32000,
  maxOutputTokens: 4096,
  timeoutMs: 50,
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  certificationStatus: "planner_certified",
};

const model = {
  id: "bacon",
  endpoint: "https://internal.example/chat/completions",
  requestDialect: "internal_chat_completions",
  authScheme: "ACCESSCODE",
  credential: "secret",
  capabilities: capability,
  configVersion: "test-v1",
};

const registry = { require: vi.fn(() => model) };

describe("InternalModelAdapter", () => {
  it("preserves assistant tool calls and matching tool_call_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "provider-req-1",
      choices: [{
        message: {
          content: "工具调用完成。",
          tool_calls: [{
            id: "call-2",
            type: "function",
            function: { name: "query_dashboard_summary", arguments: "{\"filters\":{}}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });

    const response = await adapter.invoke({
      modelId: "bacon",
      purpose: "planning",
      messages: [
        { role: "user", content: "count defects" },
        { role: "assistant", content: "", toolCalls: [{ toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: "{\"filters\":{}}" }] },
        { role: "tool", toolCallId: "call-1", name: "query_dashboard_summary", content: "{\"overview\":{\"ticket_count\":12}}" },
      ],
      temperature: 0,
      maxOutputTokens: 32,
      allowParallelToolCalls: false,
    }, { signal: new AbortController().signal });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_token_length).toBe(32);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "query_dashboard_summary", arguments: "{\"filters\":{}}" } }],
    });
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", name: "query_dashboard_summary" });
    expect(response).toMatchObject({
      text: "工具调用完成。",
      finishReason: "tool_calls",
      providerRequestId: "provider-req-1",
      usage: { inputTokens: 11, outputTokens: 7 },
      toolCalls: [{ toolCallId: "call-2", name: "query_dashboard_summary", argumentsText: "{\"filters\":{}}" }],
    });
  });

  it("classifies caller cancellation without retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const adapter = createInternalModelAdapter({ registry, fetchImpl });

    await expect(adapter.invoke({
      modelId: "bacon",
      purpose: "render",
      messages: [],
      temperature: 0,
      maxOutputTokens: 32,
      allowParallelToolCalls: false,
    }, { signal: controller.signal })).rejects.toMatchObject({ code: "MODEL_CANCELLED", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses OpenAI max_tokens for openai_chat_completions records", async () => {
    const openAiModel = { ...model, requestDialect: "openai_chat_completions" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry: { require: vi.fn(() => openAiModel) }, fetchImpl });

    await adapter.invoke({ modelId: "bacon", purpose: "render", messages: [], temperature: 0, maxOutputTokens: 64, allowParallelToolCalls: false }, { signal: new AbortController().signal });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(64);
    expect(body).not.toHaveProperty("max_token_length");
  });

  it("retries retryable 500s but not non-retryable 400s", async () => {
    const retryModel = { ...model, capabilities: { ...capability, retryPolicy: { maxAttempts: 2, backoffMs: 0 } } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Server Error" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry: { require: vi.fn(() => retryModel) }, fetchImpl });

    await expect(adapter.invoke({ modelId: "bacon", purpose: "render", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false }, { signal: new AbortController().signal })).resolves.toMatchObject({ text: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const badRequestFetch = vi.fn().mockResolvedValue(new Response("bad", { status: 400, statusText: "Bad Request" }));
    const badAdapter = createInternalModelAdapter({ registry: { require: vi.fn(() => retryModel) }, fetchImpl: badRequestFetch });
    await expect(badAdapter.invoke({ modelId: "bacon", purpose: "render", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "MODEL_HTTP_400", retryable: false });
    expect(badRequestFetch).toHaveBeenCalledTimes(1);
  });

  it("strips reasoning content and rejects empty responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "<think>private</think> public" }, finish_reason: "stop" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "<think>private</think>" }, finish_reason: "stop" }] }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });
    const request = { modelId: "bacon", purpose: "render", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false };

    await expect(adapter.invoke(request, { signal: new AbortController().signal })).resolves.toMatchObject({ text: "public" });
    await expect(adapter.invoke(request, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "MODEL_EMPTY_RESPONSE", retryable: false });
  });

  it("streams split SSE frames, tool-call deltas and usage", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你',
      '好","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"query_dashboard_summary","arguments":"{\\"filters"}}]},"finish_reason":null}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":{}}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });

    const events = [];
    for await (const event of adapter.stream({ modelId: "bacon", purpose: "planning", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false }, { signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "content_delta", text: "你好" });
    expect(events).toContainEqual({ type: "tool_call_delta", toolCallId: "call-1", name: "query_dashboard_summary", argumentsDelta: '{"filters' });
    expect(events).toContainEqual({ type: "tool_call_delta", toolCallId: "call-1", argumentsDelta: '":{}}' });
    expect(events).toContainEqual({ type: "usage", inputTokens: 3, outputTokens: 2 });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: {
        text: "你好",
        finishReason: "tool_calls",
        toolCalls: [{ toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: '{"filters":{}}' }],
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    });
  });

  it("validates structured JSON output and performs one deterministic repair", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not-json" }, finish_reason: "stop" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "{\"answer\":\"ok\"}" }, finish_reason: "stop" }] }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });

    await expect(adapter.invoke({
      modelId: "bacon",
      purpose: "render",
      messages: [],
      temperature: 0,
      maxOutputTokens: 32,
      allowParallelToolCalls: false,
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    }, { signal: new AbortController().signal })).resolves.toMatchObject({ text: "{\"answer\":\"ok\"}" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const repairBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(firstBody.messages.at(-1).content).toContain("Return only JSON");
    expect(repairBody.messages.at(-1).content).toContain("Repair the previous response");
  });

  it("cancels the upstream stream reader when parsing fails", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode("data: {bad json}\n\n"));
      },
      cancel,
    }), { status: 200 }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });

    const consume = async () => {
      for await (const _event of adapter.stream({ modelId: "bacon", purpose: "planning", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false }, { signal: new AbortController().signal })) {
        // consume until parser error
      }
    };

    await expect(consume()).rejects.toThrow(/JSON/);
    expect(cancel).toHaveBeenCalled();
  });
});
