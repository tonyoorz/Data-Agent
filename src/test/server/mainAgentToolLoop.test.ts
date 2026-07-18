// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveMainAgentToolContext, shouldPlanMainAgentTools } from "../../../server/mainAgentToolLoop.mjs";

describe("legacy Main Agent compatibility adapter", () => {
  it("uses a routing hint only for analytics-shaped questions", () => {
    expect(shouldPlanMainAgentTools([{ role: "user", content: "DTSV 6月份提了多少bug？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "这个 camera black screen 缺陷是不是重复？" }])).toBe(true);
    expect(shouldPlanMainAgentTools([{ role: "user", content: "请润色这段话" }])).toBe(false);
  });

  it("fails closed when the durable Runtime adapter is not injected", async () => {
    await expect(resolveMainAgentToolContext({ messages: [{ role: "user", content: "缺陷数" }] }))
      .rejects.toMatchObject({ code: "MAIN_AGENT_RUNTIME_ADAPTER_REQUIRED" });
  });

  it("delegates planning and execution to the same Runtime and only adapts public events", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      runId: "run-v2",
      answer: {
        text: "缺陷数为 12。",
        citations: [{ citationId: "cite-1", label: "defect.count@1.0.0", claimIds: ["claim-1"], evidenceIds: ["ev-s1"] }],
      },
      events: [
        { type: "intent.resolved", payload: { intent: "aggregate" } },
        { type: "tool.started", payload: { attemptId: "s1", toolName: "query_semantic_metrics", redactedCanonicalArgs: { query: { metricIds: ["defect.count"] } } } },
        { type: "tool.completed", payload: { attemptId: "s1", status: "succeeded", evidenceIds: ["ev-s1"] } },
        { type: "claims.validated", payload: { acceptedClaimIds: ["claim-1"], rejectedClaimIds: [] } },
      ],
    });

    const result = await resolveMainAgentToolContext({
      messages: [{ role: "user", content: "今年缺陷数" }],
      model: "certified-model",
      runAgent,
    });

    expect(runAgent).toHaveBeenCalledWith({ queryText: "今年缺陷数", selectedModel: "certified-model" });
    expect(result).toMatchObject({ runId: "run-v2", stoppedReason: "runtime_completed", answer: { text: "缺陷数为 12。" } });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "query_semantic_metrics" }) }),
    ]);
    expect(result.toolConversationMessages).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("system prompt");
  });
});
