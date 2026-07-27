import { describe, expect, it, vi } from "vitest";

import { streamLangGraphChatResponse } from "../../../../server/agentRuntime/langGraphChatHandler.mjs";

describe("LangGraph chat handler", () => {
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
      }),
    );
    expect(result.runtimeResult.threadId).toBe("thread-1");
    expect(result.streamMetrics).toEqual({ streamTotalMs: 12 });
  });
});