import { describe, expect, it } from "vitest";

import { compactChatMessages } from "../../../server/chatMessageBudget.mjs";

describe("compactChatMessages", () => {
  it("keeps recent messages within the configured budget", () => {
    const messages = [
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant" },
      { role: "user", content: "recent user question" },
      { role: "assistant", content: "recent assistant answer" },
    ];

    expect(compactChatMessages(messages, { maxChars: 55 })).toEqual([
      { role: "user", content: "recent user question" },
      { role: "assistant", content: "recent assistant answer" },
    ]);
  });

  it("preserves tool-call and tool-result pairs at the end of the conversation", () => {
    const toolCalls = [{ id: "call-1", type: "function", function: { name: "query_dashboard_summary", arguments: "{}" } }];
    const messages = [
      { role: "user", content: "old".repeat(50) },
      { role: "user", content: "How many defects?" },
      { role: "assistant", content: "", tool_calls: toolCalls },
      { role: "tool", tool_call_id: "call-1", name: "query_dashboard_summary", content: '{"ticket_count":12}' },
    ];

    const compacted = compactChatMessages(messages, { maxChars: 160 });

    expect(compacted).toEqual(messages.slice(1));
  });

  it("keeps a complete tool-call pair even when the pair exceeds the remaining budget", () => {
    const toolCalls = [{ id: "call-1", type: "function", function: { name: "query_dashboard_summary", arguments: "{}" } }];
    const messages = [
      { role: "user", content: "old context that should be dropped" },
      { role: "assistant", content: "", tool_calls: toolCalls },
      { role: "tool", tool_call_id: "call-1", name: "query_dashboard_summary", content: '{"ticket_count":12,"snapshot":"snapshot-20260709"}' },
    ];

    expect(compactChatMessages(messages, { maxChars: 10 })).toEqual(messages.slice(1));
  });

  it("removes empty assistant messages that are not tool-call carriers", () => {
    const messages = [
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Useful answer" },
    ];

    expect(compactChatMessages(messages, { maxChars: 100 })).toEqual([
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "Useful answer" },
    ]);
  });

  it("truncates oversized single string messages from the front", () => {
    const compacted = compactChatMessages(
      [{ role: "user", content: `prefix ${"x".repeat(80)} important suffix` }],
      { maxChars: 40, maxMessageChars: 30 },
    );

    expect(compacted).toEqual([
      {
        role: "user",
        content: "[truncated]\nxxxxxxxxxxxxx important suffix",
      },
    ]);
  });
});