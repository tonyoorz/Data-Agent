// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildShadowRuntimeResult, createShadowDispatcher } from "../../../../server/agentRuntime/shadow.mjs";

const actor = { actorId: "alice", scopeHash: "scope-hash" };

function fixture(mode = "shadow") {
  const runtime = { startRun: vi.fn().mockResolvedValue({ threadId: "thread-1", runId: "run-1", threadVersion: 0 }) };
  const auditStore = { append: vi.fn() };
  const telemetry = { record: vi.fn() };
  const modelRegistry = {
    defaultModelId: "certified",
    require: vi.fn((modelId: string) => {
      if (modelId === "chat-only") throw new Error("MODEL_NOT_CERTIFIED_FOR_PLANNING");
      return { id: modelId };
    }),
  };
  const dispatcher = createShadowDispatcher({
    runtime,
    identityResolver: vi.fn().mockResolvedValue(actor),
    config: { mode, resolveRuntimeMode: () => mode },
    modelRegistry,
    auditStore,
    telemetry,
  });
  return { dispatcher, runtime, auditStore, telemetry };
}

describe("shadow runtime dispatcher", () => {
  it("starts a background shadow run and audits only structured correlation data", async () => {
    const { dispatcher, runtime, auditStore } = fixture();
    const shadow = await dispatcher.dispatch({
      request: { headers: {} },
      correlationId: "request-1",
      queryText: "2026 年 DTSV 有多少缺陷？",
      selectedModel: "chat-only",
      useDefectContext: false,
      useAnalyticsContext: true,
    });

    expect(shadow).toMatchObject({ runId: "run-1", actor });
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      runtimeMode: "shadow",
      request: expect.objectContaining({ selectedModel: "certified", useAnalyticsContext: true }),
    }));
    expect(JSON.stringify(auditStore.append.mock.calls)).not.toContain("DTSV 有多少缺陷");

    dispatcher.recordLegacyOutcome({
      shadow,
      status: "completed",
      metrics: { model: "legacy", streamTotalMs: 12, answerContentHash: "abc", answerCharacterCount: 9, numericTokenCount: 1, numericSignature: "a".repeat(64), semanticSignature: "b".repeat(64), scopeSignature: "c".repeat(64), toolSignature: "d".repeat(64) },
    });
    expect(auditStore.append).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "runtime.shadow_legacy_result",
      details: expect.objectContaining({ answerContentHash: "abc", answerCharacterCount: 9, numericSignature: "a".repeat(64), semanticSignature: "b".repeat(64) }),
    }));
  });

  it("does nothing when the server decision is not shadow", async () => {
    const { dispatcher, runtime } = fixture("legacy");
    await expect(dispatcher.dispatch({ request: {}, correlationId: "request-2", queryText: "query" })).resolves.toBeNull();
    expect(runtime.startRun).not.toHaveBeenCalled();
  });

  it("builds a text-free structured runtime result", () => {
    const report = buildShadowRuntimeResult({
      durationMs: 17,
      state: {
        semanticFrame: { intent: "aggregate", entityIds: ["quality.defect"], metricIds: ["defect.count"], dimensionIds: [], ambiguities: [] },
        plan: { steps: [{ toolName: "query_semantic_metrics" }] },
        evidence: [{ evidenceId: "e1" }],
        claimValidation: { acceptedClaimIds: ["c1"] },
        answer: { text: "sensitive answer body", contentHash: "answer-hash", citations: [{ citationId: "cite-1" }], groundingStatus: "grounded" },
      },
    });

    expect(report).toMatchObject({ status: "completed", tools: ["query_semantic_metrics"], groundingStatus: "grounded", answerContentHash: "answer-hash", numericTokenCount: 0, semanticSignature: expect.stringMatching(/^[a-f0-9]{64}$/), scopeSignature: expect.stringMatching(/^[a-f0-9]{64}$/), toolSignature: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(report)).not.toContain("sensitive answer body");
  });
});
