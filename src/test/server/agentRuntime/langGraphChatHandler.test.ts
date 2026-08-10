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

  it("never releases a direct response when claim-bearing evidence requires validation", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        threadId: "thread-1",
        actorScope: { scopeHash: "scope-a" },
        directResponse: { content: "LEAK_DIRECT_CLAIM: 缺陷数是 12" },
        mainAgentToolContext: {
          evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snap-1"] },
          evidence: [{
            toolCallId: "call-1", tool: "query_semantic_metrics", ok: true,
            ontologyVersion: "v1", schemaFingerprint: "fingerprint-1", analysisRef: "analysis-1",
            sourceRevision: { revisionId: "snap-1", status: "pinned" }, scope: { actorScopeHash: "scope-a" },
            quality: { completeness: "complete", warnings: [] },
            evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
          }],
        },
        metrics: {
          mainAgentToolCallCount: 1,
          evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snap-1"] },
        },
      })),
    };
    const streamCompletion = vi.fn();
    const onCompleted = vi.fn();

    const result = await streamLangGraphChatResponse({
      response,
      runtime,
      streamCompletion,
      onCompleted,
    });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(streamedText).not.toContain("LEAK_DIRECT_CLAIM");
    expect(streamedText).not.toContain("缺陷数是 12");
    expect(streamedText).toContain("受治理证据不可用");
    expect(streamedText).toContain("ANSWER_DIRECT_RESPONSE_CLAIM_BYPASS_BLOCKED");
    expect(streamedText.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(result.answerValidation).toEqual({
      valid: false,
      violations: ["ANSWER_DIRECT_RESPONSE_CLAIM_BYPASS_BLOCKED"],
    });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      answerValidation: expect.objectContaining({ valid: false }),
    }));
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
          actorScope: { scopeHash: "scope-a" },
          mainAgentToolContext: {
            evidence: [{
              toolCallId: "call-1",
              tool: "query_semantic_metrics",
              ok: true,
              ontologyVersion: "v1",
              schemaFingerprint: "fingerprint-1",
              analysisRef: "analysis-1",
              sourceRevision: { revisionId: "snap-1", status: "pinned" },
              scope: { actorScopeHash: "scope-a" },
              quality: { completeness: "complete", warnings: [] },
              evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
            }],
            evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snap-1"] },
          },
          metrics: {
            mainAgentToolCallCount: 1,
            evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snap-1"] },
          },
        };
      }),
    };
    const streamCompletion = vi.fn(async ({ onMetrics, onAnswerValidation }) => {
      onAnswerValidation({ valid: true, violations: [] });
      onMetrics({ streamTotalMs: 12 });
    });
    const writeEvent = vi.fn();
    const onCompleted = vi.fn();

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
      onCompleted,
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
          releaseRequired: true,
          expectedActorScopeHash: "scope-a",
          expectedSourceRevisionIds: ["snap-1"],
          evidence: [expect.objectContaining({ toolCallId: "call-1", tool: "query_semantic_metrics" })],
          registry: expect.objectContaining({ version: "v1" }),
        }),
      }),
    );
    expect(result.runtimeResult.threadId).toBe("thread-1");
    expect(result.streamMetrics).toEqual({ streamTotalMs: 12 });
    expect(result.answerValidation).toEqual({ valid: true, violations: [] });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      streamMetrics: { streamTotalMs: 12 },
      answerValidation: { valid: true, violations: [] },
    }));
  });

  it("skips the final model and suppresses evidence prefaces when the evidence gate is blocked", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        threadId: "thread-1",
        finalMessages: [{ role: "user", content: "缺陷数是多少？" }],
        context: "# Tool context\nLEAK_BLOCKED_CONTEXT: 999",
        prefaceEvents: [{
          type: "tool-output-available",
          toolName: "query_semantic_metrics",
          outputSummary: "LEAK_BLOCKED_PREFACE: 999",
        }],
        actorScope: { scopeHash: "scope-a" },
        mainAgentToolContext: {
          evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics" }],
          evidenceGate: {
            status: "blocked",
            violations: ["SEMANTIC_SCOPE_EVIDENCE_MISMATCH"],
            sourceRevisionIds: ["snap-1"],
          },
        },
        metrics: {
          mainAgentToolCallCount: 1,
          evidenceGate: {
            status: "blocked",
            violations: ["SEMANTIC_SCOPE_EVIDENCE_MISMATCH"],
            sourceRevisionIds: ["snap-1"],
          },
        },
      })),
    };
    const streamCompletion = vi.fn();
    const onCompleted = vi.fn();

    const result = await streamLangGraphChatResponse({
      body: { threadId: "thread-1", messages: [{ role: "user", content: "缺陷数是多少？" }] },
      response,
      runtime,
      streamCompletion,
      onCompleted,
    });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(streamedText).not.toContain("LEAK_BLOCKED_CONTEXT");
    expect(streamedText).not.toContain("LEAK_BLOCKED_PREFACE");
    expect(streamedText).toContain("受治理证据不可用");
    expect(streamedText).toContain('"type":"answer-validation"');
    expect(streamedText).toContain("SEMANTIC_SCOPE_EVIDENCE_MISMATCH");
    expect(streamedText.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(result.answerValidation).toEqual({
      valid: false,
      violations: ["SEMANTIC_SCOPE_EVIDENCE_MISMATCH"],
    });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      answerValidation: expect.objectContaining({ valid: false }),
      streamMetrics: expect.objectContaining({ evidenceReleaseBlocked: true }),
    }));
  });

  it("fails closed before the final model when claim evidence has no declared release binding", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        threadId: "thread-1",
        actorScope: { scopeHash: "scope-a" },
        finalMessages: [{ role: "user", content: "trace count" }],
        mainAgentToolContext: {
          evidence: [{
            toolCallId: "trace-1", tool: "query_traceability", ok: true,
            ontologyVersion: "v1", schemaFingerprint: "fingerprint-1", analysisRef: "analysis-1",
            sourceRevision: { revisionId: "snap-1", status: "pinned" }, scope: { actorScopeHash: "scope-a" },
            quality: { completeness: "complete", warnings: [] },
            evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
          }],
        },
        metrics: { mainAgentToolCallCount: 1 },
      })),
    };
    const streamCompletion = vi.fn();

    const result = await streamLangGraphChatResponse({ response, runtime, streamCompletion });

    expect(streamCompletion).not.toHaveBeenCalled();
    expect(result.answerValidation).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["SEMANTIC_EVIDENCE_GATE_MISSING"]),
    }));
    expect(response.write.mock.calls.map(([chunk]) => String(chunk)).join(""))
      .toContain("SEMANTIC_EVIDENCE_GATE_MISSING");
  });

  it("propagates a buffered answer validation failure to the terminal completion observer", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        threadId: "thread-1",
        actorScope: { scopeHash: "scope-a" },
        finalMessages: [{ role: "user", content: "缺陷数是多少？" }],
        context: "# Tool context",
        prefaceEvents: [],
        mainAgentToolContext: {
          evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snap-1"] },
          evidence: [{
            toolCallId: "call-1", tool: "query_semantic_metrics", ok: true,
            ontologyVersion: "v1", schemaFingerprint: "fingerprint-1", analysisRef: "analysis-1",
            sourceRevision: { revisionId: "snap-1", status: "pinned" }, scope: { actorScopeHash: "scope-a" },
            quality: { completeness: "complete", warnings: [] },
            evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
          }],
        },
      })),
    };
    const streamCompletion = vi.fn(async ({ onAnswerValidation, onMetrics }) => {
      onAnswerValidation({ valid: false, violations: ["ANSWER_CITATION_REQUIRED"] });
      onMetrics({ streamTotalMs: 15 });
    });
    const onCompleted = vi.fn();

    const result = await streamLangGraphChatResponse({
      response,
      runtime,
      streamCompletion,
      onCompleted,
    });

    expect(result.answerValidation).toEqual({ valid: false, violations: ["ANSWER_CITATION_REQUIRED"] });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      streamMetrics: { streamTotalMs: 15 },
      answerValidation: { valid: false, violations: ["ANSWER_CITATION_REQUIRED"] },
    }));
  });

  it("does not write after stream completion when a telemetry observer fails", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), writableEnded: false };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        runId: "run-1",
        threadId: "thread-1",
        finalMessages: [{ role: "user", content: "DTSV count" }],
        context: "",
        prefaceEvents: [],
        mainAgentToolContext: null,
        metrics: { mainAgentToolCallCount: 0 },
      })),
    };
    const streamCompletion = vi.fn(async ({ onMetrics }) => {
      response.writableEnded = true;
      onMetrics({ streamTotalMs: 10 });
    });
    const onCompleted = vi.fn(async () => { throw new Error("telemetry unavailable"); });

    await expect(streamLangGraphChatResponse({
      body: { threadId: "thread-1", messages: [{ role: "user", content: "DTSV count" }] },
      response,
      runtime,
      streamCompletion,
      onCompleted,
    })).resolves.toEqual(expect.objectContaining({ streamMetrics: { streamTotalMs: 10 } }));
    expect(response.write).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});
