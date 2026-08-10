import { describe, expect, it, vi } from "vitest";

import { runMainAgentToolTurn } from "../../../server/mainAgentToolOrchestrator.mjs";

describe("main agent tool orchestrator", () => {
  it("emits standard turn and tool lifecycle events", async () => {
    const toolCall = { id: "call-1", type: "function", function: { name: "query_analytics", arguments: "{}" } };
    const requestToolCompletion = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [toolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_analytics", content: "{}" },
      contextText: "# Main agent tool result\nTool: query_analytics\nResult: 1",
    });

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestToolCompletion,
      executeToolCall,
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent.turn.started",
      "agent.tool.planned",
      "agent.tool.started",
      "agent.tool.completed",
      "agent.turn.completed",
    ]));
    expect(result.uiToolEvents.map((event) => event.type)).toEqual(["tool-input-available", "tool-output-available"]);
    expect(result.contextText).toContain("Result: 1");
  });
});