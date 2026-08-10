import { describe, expect, it, vi } from "vitest";

import { streamLangGraphChatResponse } from "../../../../server/agentRuntime/langGraphChatHandler.mjs";

describe("LangGraph chat handler", () => {
  it("streams a runtime direct response without calling the final chat model", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        threadId: "thread-1",
        directResponse: { content: "你好，我可以帮你看测试质量和缺陷数据。" },
        metrics: { mainAgentToolCallCount: 0 },
      })),
    };
    const streamCompletion = vi.fn();

    const result = await streamLangGraphChatResponse({
      body: {
        threadId: "thread-1",
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "你好" }],
      },
      response,
      runtime,
      streamCompletion,
    });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(streamedText).toContain("你好，我可以帮你看测试质量和缺陷数据。");
    expect(streamedText).toContain("data: [DONE]");
    expect(response.end).toHaveBeenCalled();
    expect(result.streamMetrics).toEqual(expect.objectContaining({ directResponse: true }));
  });

  it("streams a response using graph-produced messages, context, and preface events", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    const runtime = {
      invoke: vi.fn(async (_input, options) => {
        options.onEvent({ type: "agent-runtime-started", threadId: "thread-1" });
        return {
          runtime: "langgraph",
          threadId: "thread-1",
          finalMessages: [
            { role: "user", content: "DTSV 6月份提了多少bug？" },
            { role: "tool", name: "query_semantic_metrics", content: "{}" },
          ],
          context: "# Tool context",
          prefaceEvents: [{ type: "tool-output-available", toolName: "query_semantic_metrics" }],
          mainAgentToolContext: { evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics" }] },
          metrics: { mainAgentToolCallCount: 1 },
        };
      }),
    };
    const streamCompletion = vi.fn(async ({ onMetrics }) => {
      onMetrics({ streamTotalMs: 12 });
    });
    const writeEvent = vi.fn();

    const result = await streamLangGraphChatResponse({
      body: {
        threadId: "thread-1",
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      },
      response,
      runtime,
      toolDependencies: { runDuplicateBridge: "bridge" },
      streamCompletion,
      writeEvent,
    });

    expect(runtime.invoke).toHaveBeenCalledWith(
      {
        body: expect.objectContaining({ threadId: "thread-1" }),
        toolDependencies: { runDuplicateBridge: "bridge" },
      },
      { onEvent: expect.any(Function) },
    );
    expect(writeEvent).toHaveBeenCalledWith(response, {
      type: "agent-runtime-event",
      event: { type: "agent-runtime-started", threadId: "thread-1" },
    });
    expect(streamCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "DTSV 6月份提了多少bug？" },
          { role: "tool", name: "query_semantic_metrics", content: "{}" },
        ],
        model: "deepseek-v4-flash",
        context: "# Tool context",
        response,
        prefaceEvents: [{ type: "tool-output-available", toolName: "query_semantic_metrics" }],
        answerValidation: expect.objectContaining({
          evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics" }],
          registry: expect.objectContaining({ version: "v1" }),
        }),
      }),
    );
    expect(result.runtimeResult.threadId).toBe("thread-1");
    expect(result.streamMetrics).toEqual({ streamTotalMs: 12 });
  });
});