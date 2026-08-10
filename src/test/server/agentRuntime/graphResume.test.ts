// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createGraphNodes } from "../../../../server/agentRuntime/graph.mjs";

describe("Phase 1 graph resume helpers", () => {
  it("preserves model turn tool-call associations during compaction", () => {
    const nodes = createGraphNodes({});
    const state = nodes.compactContext({
      messages: [{ messageId: "m1", role: "user", text: "hello" }],
      modelTurns: [
        { turnId: "t1", role: "assistant", toolCalls: [{ toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: "{}" }] },
        { turnId: "t2", role: "tool", toolCallId: "call-1", toolName: "query_dashboard_summary", contentRef: "ref" },
      ],
      semanticFrame: { mode: "legacy_provisional" },
      evidence: [{ evidenceId: "ev-1" }],
      pendingInteraction: { interactionId: "i1" },
    });
    expect(state.modelTurns[0].toolCalls[0].toolCallId).toBe("call-1");
    expect(state.pendingInteraction.interactionId).toBe("i1");
  });
});