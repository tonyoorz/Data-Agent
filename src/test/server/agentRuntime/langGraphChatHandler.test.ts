import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { streamLangGraphChatResponse } from "../../../../server/agentRuntime/langGraphChatHandler.mjs";
import { createLangGraphChatRuntime } from "../../../../server/agentRuntime/langGraphChatRuntime.mjs";
import { createFileAgentRuntimeStore } from "../../../../server/agentRuntime/runtimeAuditStore.mjs";
import { buildAgentStreamAuditEvent } from "../../../../server/agentRuntime/streamAudit.mjs";

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
          toolCalls: [{ id: "call-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } }],
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
            toolCalls: [{ id: "call-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } }],
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
      expect.objectContaining({
        body: expect.objectContaining({ threadId: "thread-1" }),
        toolDependencies: { runDuplicateBridge: "bridge" },
      }),
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

  it("blocks the final model when runtime rejects an incomplete ready governed plan candidate", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const requestToolCompletion = vi.fn();
    const executeToolCall = vi.fn();
    const runtime = createLangGraphChatRuntime({
      resolveAnalyticsContext: vi.fn().mockResolvedValue({
        contextText: "# Analytics",
        queryPlan: { status: "valid" },
      }),
      shouldPlanTools: vi.fn().mockReturnValue(false),
      requestToolCompletion,
      executeToolCall,
    });
    const streamCompletion = vi.fn();

    const result = await streamLangGraphChatResponse({
      body: {
        threadId: "thread-invalid-ready-plan",
        useAnalyticsContext: true,
        actor: {
          actorId: "alice",
          scopeHash: "scope-a",
          scopes: { workspaceIds: ["DTSV"], allowedObjectTypes: ["quality.defect"] },
        },
        messages: [{ role: "user", content: "缺陷总数" }],
      },
      response,
      runtime,
      streamCompletion,
    });

    expect(requestToolCompletion).not.toHaveBeenCalled();
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(result.runtimeResult.mainAgentToolContext.evidenceGate).toEqual(expect.objectContaining({
      status: "blocked",
      violations: ["GOVERNED_QUERY_PLAN_SCHEMA_INVALID"],
    }));
    expect(result.streamMetrics).toEqual({ evidenceReleaseBlocked: true, finalModelInvoked: false });
    expect(response.write.mock.calls.map(([chunk]) => String(chunk)).join(""))
      .toContain("GOVERNED_QUERY_PLAN_SCHEMA_INVALID");
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
          toolCalls: [{ id: "trace-1", type: "function", function: { name: "query_traceability", arguments: "{}" } }],
          evidence: [{
            toolCallId: "trace-1", tool: "query_traceability", ok: true,
            ontologyVersion: "v1", schemaFingerprint: "fingerprint-1", analysisRef: "analysis-1",
            sourceRevision: { revisionId: "snap-1", status: "pinned" }, scope: { actorScopeHash: "scope-a" },
            quality: { completeness: "complete", warnings: [] },
            evidence: { kind: "semantic_lineage_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
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
          toolCalls: [{ id: "call-1", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } }],
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

  it("blocks a legacy fact-producing tool before final streaming without leaking context or prefaces", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        runId: "run-legacy-fact",
        threadId: "thread-legacy-fact",
        actorScope: { scopeHash: "scope-a" },
        finalMessages: [{ role: "user", content: "缺陷总数是多少？" }],
        context: "# Tool context\nLEAK_LEGACY_CONTEXT: 12",
        prefaceEvents: [{ type: "tool-output-available", outputSummary: "LEAK_LEGACY_PREFACE: 12" }],
        mainAgentToolContext: {
          toolCalls: [{ id: "legacy-1", type: "function", function: { name: "query_defect_aggregate", arguments: "{}" } }],
          evidence: [{
            toolCallId: "legacy-1",
            tool: "query_defect_aggregate",
            ok: true,
            summary: { defectCount: 12 },
          }],
          evidenceGate: { status: "not_required", violations: [] },
        },
        metrics: { mainAgentToolCallCount: 1, evidenceGate: { status: "not_required", violations: [] } },
      })),
    };
    const streamCompletion = vi.fn(async () => {
      response.write('data: {"choices":[{"delta":{"content":"LEAK_LEGACY_MODEL: 12"}}]}\n\n');
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const onCompleted = vi.fn();

    const result = await streamLangGraphChatResponse({ response, runtime, streamCompletion, onCompleted });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(streamedText).not.toContain("LEAK_LEGACY_CONTEXT");
    expect(streamedText).not.toContain("LEAK_LEGACY_PREFACE");
    expect(streamedText).not.toContain("LEAK_LEGACY_MODEL");
    expect(streamedText).toContain("CLAIM_TOOL_RELEASE_CONTRACT_MISSING:query_defect_aggregate");
    expect(streamedText.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(result.answerValidation).toEqual(expect.objectContaining({ valid: false }));
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("persists a blocked terminal decision even when the client disconnects before the safe response", async () => {
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(() => { throw new Error("socket closed"); }),
      end: vi.fn(),
      flushHeaders: vi.fn(),
    };
    const runtime = {
      invoke: vi.fn(async (_input, config) => {
        config?.onEvent?.({ type: "tool-routing-completed" });
        return {
          runId: "run-blocked-disconnect",
          threadId: "thread-blocked-disconnect",
          actorScope: { scopeHash: "scope-a" },
          finalMessages: [{ role: "user", content: "缺陷总数" }],
          context: "",
          prefaceEvents: [],
          mainAgentToolContext: {
            toolCalls: [{ id: "legacy-1", function: { name: "query_defect_aggregate" } }],
            evidence: [{ toolCallId: "legacy-1", tool: "query_defect_aggregate", ok: true }],
            evidenceGate: {
              status: "blocked",
              violations: ["CLAIM_TOOL_RELEASE_CONTRACT_MISSING:query_defect_aggregate"],
            },
          },
          metrics: { mainAgentToolCallCount: 1 },
        };
      }),
    };
    const onCompleted = vi.fn();
    const streamCompletion = vi.fn();

    const result = await streamLangGraphChatResponse({
      response,
      runtime,
      streamCompletion,
      onCompleted,
      writeEvent: vi.fn(() => { throw new Error("socket closed"); }),
    });

    expect(streamCompletion).not.toHaveBeenCalled();
    expect(result.answerValidation).toEqual({
      valid: false,
      violations: ["CLAIM_TOOL_RELEASE_CONTRACT_MISSING:query_defect_aggregate"],
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      runtimeResult: expect.objectContaining({ runId: "run-blocked-disconnect" }),
      answerValidation: expect.objectContaining({ valid: false }),
    }));
  });

  it("blocks an executed factual tool when its evidence envelope is missing", async () => {
    const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn() };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        runId: "run-missing-evidence",
        threadId: "thread-missing-evidence",
        actorScope: { scopeHash: "scope-a" },
        finalMessages: [{ role: "user", content: "缺陷总数是多少？" }],
        context: "# Tool context\nLEAK_MISSING_EVIDENCE: 12",
        prefaceEvents: [],
        mainAgentToolContext: {
          toolCalls: [{
            id: "missing-evidence-1",
            type: "function",
            function: { name: "query_defect_aggregate", arguments: "{}" },
          }],
          evidence: [],
          evidenceGate: { status: "not_required", violations: [] },
        },
        metrics: { mainAgentToolCallCount: 1, evidenceGate: { status: "not_required", violations: [] } },
      })),
    };
    const streamCompletion = vi.fn();

    const result = await streamLangGraphChatResponse({ response, runtime, streamCompletion });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamCompletion).not.toHaveBeenCalled();
    expect(streamedText).not.toContain("LEAK_MISSING_EVIDENCE");
    expect(streamedText).toContain("CLAIM_TOOL_EVIDENCE_MISSING:missing-evidence-1/query_defect_aggregate");
    expect(result.answerValidation).toEqual(expect.objectContaining({ valid: false }));
  });

  it("records one typed failed terminal audit and never exposes a provider exception", async () => {
    const auditRoot = await mkdtemp(path.join(tmpdir(), "agent-stream-audit-"));
    const auditStore = createFileAgentRuntimeStore({ rootDir: auditRoot });
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      flushHeaders: vi.fn(),
      writableEnded: false,
    };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        runId: "run-provider-throw",
        threadId: "thread-provider-throw",
        finalMessages: [{ role: "user", content: "你好" }],
        context: "",
        prefaceEvents: [],
        mainAgentToolContext: null,
        metrics: { mainAgentToolCallCount: 0 },
      })),
    };
    const streamCompletion = vi.fn(async () => {
      throw new Error("SECRET_PROVIDER_DETAIL api-key=should-not-leak");
    });
    const onCompleted = vi.fn(async (completed) => {
      await auditStore.appendRunEvent(buildAgentStreamAuditEvent(completed));
    });

    const result = await streamLangGraphChatResponse({ response, runtime, streamCompletion, onCompleted });

    const streamedText = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(streamedText).not.toContain("SECRET_PROVIDER_DETAIL");
    expect(streamedText).not.toContain("api-key");
    expect(streamedText).toContain('"type":"agent-terminal"');
    expect(streamedText).toContain('"status":"failed"');
    expect(streamedText).toContain('"code":"FINAL_STREAM_FAILED"');
    expect(streamedText.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      terminal: { status: "failed", code: "FINAL_STREAM_FAILED" },
      streamMetrics: expect.objectContaining({ terminalStatus: "failed", failureCode: "FINAL_STREAM_FAILED" }),
    }));
    expect(result).toEqual(expect.objectContaining({
      terminal: { status: "failed", code: "FINAL_STREAM_FAILED" },
    }));
    const auditLines = (await readFile(path.join(auditRoot, "run-events.jsonl"), "utf8")).trim().split("\n");
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0])).toMatchObject({
      runId: expect.stringMatching(/^run-[a-f0-9]{64}$/),
      type: "agent-stream-completed",
      terminalStatus: "failed",
      failureCode: "FINAL_STREAM_FAILED",
      citationValidation: "blocked",
    });
    expect(auditLines[0]).not.toContain("SECRET_PROVIDER_DETAIL");
    expect(auditLines[0]).not.toContain("api-key");
    expect(auditLines[0]).not.toContain("run-provider-throw");
  });

  it("still completes the failed audit when writing the safe terminal also throws", async () => {
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(() => { throw new Error("socket closed"); }),
      end: vi.fn(),
      flushHeaders: vi.fn(),
      writableEnded: false,
    };
    const runtime = {
      invoke: vi.fn(async () => ({
        runtime: "langgraph",
        runId: "run-terminal-write-throw",
        threadId: "thread-terminal-write-throw",
        finalMessages: [{ role: "user", content: "你好" }],
        context: "",
        prefaceEvents: [],
        mainAgentToolContext: null,
        metrics: { mainAgentToolCallCount: 0 },
      })),
    };
    const onCompleted = vi.fn();

    await expect(streamLangGraphChatResponse({
      response,
      runtime,
      streamCompletion: vi.fn(async () => { throw new Error("provider failed"); }),
      onCompleted,
    })).resolves.toMatchObject({ terminal: { status: "failed", code: "FINAL_STREAM_FAILED" } });

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      terminal: { status: "failed", code: "FINAL_STREAM_FAILED" },
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
