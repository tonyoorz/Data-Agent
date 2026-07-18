import { describe, expect, it } from "vitest";
import { AgentEventProtocolError, createAgentEventDecoder } from "../../lib/agentEventStream";

const event = (overrides = {}) => ({
  schemaVersion: "1.0",
  eventId: "evt-1",
  runId: "run-1",
  threadId: "thread-1",
  stateVersion: 1,
  sequence: 1,
  timestamp: "2026-07-14T00:00:00.000Z",
  type: "run.started",
  payload: { threadVersion: 1, runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash" },
  ...overrides,
});

describe("agent-v1 SSE decoder", () => {
  it("decodes UTF-8, CRLF, comments and multiline data across arbitrary byte chunks", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    const encoder = new TextEncoder();
    const payload = JSON.stringify(event());
    const frame = `: heartbeat\r\nid: evt-1\r\nevent: message\r\ndata: ${payload.slice(0, 30)}\r\ndata: ${payload.slice(30)}\r\n\r\n`;
    const bytes = encoder.encode(frame);
    const outputs = [...decoder.push(bytes.slice(0, 10)), ...decoder.push(bytes.slice(10))];
    expect(outputs).toEqual([event()]);
  });

  it("deduplicates an exact replay and rejects a conflicting sequence", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    expect(decoder.accept(event())).toEqual(event());
    expect(decoder.accept(event())).toBeNull();
    expect(() => decoder.accept(event({ eventId: "evt-2" }))).toThrow(AgentEventProtocolError);
  });

  it("validates UTF-8 answer offsets, answer id and hash", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    expect(decoder.accept(event({ eventId: "evt-a", sequence: 1, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 0, text: "中" } }))).toMatchObject({ type: "answer.delta" });
    expect(decoder.accept(event({ eventId: "evt-b", sequence: 2, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 3, text: "文" } }))).toMatchObject({ type: "answer.delta" });
    expect(() => decoder.accept(event({ eventId: "evt-c", sequence: 3, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 8, text: "B" } }))).toThrow(/ANSWER_OFFSET_MISMATCH/);
  });

  it("validates answer completion metadata and binds it to streamed answer identity", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    decoder.accept(event({ eventId: "evt-a", sequence: 1, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 0, text: "42" } }));
    expect(decoder.accept(event({
      eventId: "evt-b",
      sequence: 2,
      type: "answer.completed",
      payload: {
        answerId: "a1",
        contentHash: "hash-1",
        acceptedClaimIds: ["claim-1"],
        citations: [{ citationId: "cite-1", label: "defect.count@1", claimIds: ["claim-1"], evidenceIds: ["ev-1"] }],
        assumptions: [],
        limitations: [],
        groundingStatus: "grounded",
        sourceRevisionSet: {},
      },
    }))).toMatchObject({ type: "answer.completed" });
    expect(() => decoder.accept(event({ eventId: "evt-c", sequence: 3, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 2, text: "!" } }))).toThrow(/ANSWER_DELTA_AFTER_COMPLETION/);
  });

  it("rejects unknown, out-of-order, cross-run, and malformed completion events", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    decoder.accept(event({ eventId: "evt-2", sequence: 2 }));
    expect(() => decoder.accept(event({ eventId: "evt-1", sequence: 1 }))).toThrow(/EVENT_SEQUENCE_OUT_OF_ORDER/);
    expect(() => decoder.accept(event({ eventId: "evt-3", sequence: 3, runId: "run-2" }))).toThrow(/RUN_ID_MISMATCH/);
    expect(() => createAgentEventDecoder({ profile: "agent-v1" }).accept(event({ type: "future.event" }))).toThrow(/INVALID_AGENT_EVENT/);
    expect(() => createAgentEventDecoder({ profile: "agent-v1" }).accept(event({ type: "answer.completed", payload: { answerId: "a1" } }))).toThrow(/INVALID_ANSWER_COMPLETED/);
  });

  it("accepts legacy [DONE] only in legacy-chat profile", () => {
    const legacy = createAgentEventDecoder({ profile: "legacy-chat" });
    expect(legacy.push(new TextEncoder().encode("data: [DONE]\n\n"))).toEqual([{ type: "done" }]);
    expect(() => createAgentEventDecoder({ profile: "agent-v1" }).push(new TextEncoder().encode("data: [DONE]\n\n"))).toThrow(/INVALID_AGENT_EVENT_JSON/);
  });
});
