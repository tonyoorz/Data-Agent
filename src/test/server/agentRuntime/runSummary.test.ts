import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadAgentOperations,
  redactAuditPayload,
  summarizeRuns,
} from "../../../../server/agentRuntime/runSummary.mjs";

describe("agent run summary", () => {
  it("aggregates only normalized operational fields and redacts raw audit values", () => {
    const summary = summarizeRuns({
      summaries: [
        {
          runId: "run-1",
          threadId: "thread-1",
          actorScopeHash: "scope-a",
          intent: "metric_query",
          outcome: "completed",
          evidenceStatus: "pass",
          toolNames: ["query_semantic_metrics"],
          recoveryOutcomes: ["recovered"],
        },
        {
          runId: "run-2",
          threadId: "thread-2",
          actorScopeHash: "scope-b",
          intent: "metric_query",
          outcome: "denied",
          evidenceStatus: "blocked",
          toolNames: ["query_analytics"],
          failureCode: "TOOL_ACCESS_DENIED",
        },
        {
          runId: "run-3",
          threadId: "thread-3",
          actorScopeHash: "scope-a",
          intent: "record_query",
          outcome: "completed",
          evidenceStatus: "pass",
          toolNames: ["query_semantic_records"],
        },
      ],
      events: [
        { runId: "run-1", type: "agent-stream-completed", latencyMs: 100, citationValidation: "pass" },
        { runId: "run-2", type: "agent-stream-completed", latencyMs: 200, citationValidation: "blocked" },
        { runId: "run-3", type: "agent-stream-completed", latencyMs: 300, citationValidation: "pass" },
      ],
    });

    expect(summary).toMatchObject({
      totalRuns: 3,
      byOutcome: { completed: 2, denied: 1 },
      byEvidenceStatus: { pass: 2, blocked: 1 },
      latency: { p50Ms: 200, p95Ms: 300 },
      citationValidation: { pass: 2, blocked: 1 },
      topFailureCodes: [{ code: "TOOL_ACCESS_DENIED", count: 1 }],
      recoveryOutcomes: { recovered: 1 },
    });
    expect(summary.runs).toEqual([
      expect.objectContaining({ runRef: expect.stringMatching(/^run-[a-f0-9]{16}$/) }),
      expect.objectContaining({ runRef: expect.stringMatching(/^run-[a-f0-9]{16}$/), failureCode: "TOOL_ACCESS_DENIED" }),
      expect.objectContaining({ runRef: expect.stringMatching(/^run-[a-f0-9]{16}$/), intent: "record_query" }),
    ]);
    expect(summary.runs.every((run) => !("actorScopeHash" in run))).toBe(true);

    const redacted = redactAuditPayload({
      actorId: "alice",
      detected_by: "Alice",
      ticket_title: "Sensitive ticket",
      apiKey: "secret-key",
      input: { query: "sensitive query" },
      recovery: { queryFingerprint: "f".repeat(24) },
      toolName: "query_analytics",
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("Sensitive ticket");
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("sensitive query");
    expect(redacted).toMatchObject({
      recovery: { queryFingerprint: "f".repeat(24) },
      toolName: "query_analytics",
    });
  });

  it("loads sanitized summary and run detail from append-only audit files", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "vizion-operations-"));
    await writeFile(path.join(rootDir, "run-summaries.jsonl"), `${JSON.stringify({
      runId: "run-safe-1",
      threadId: "thread-safe-1",
      actorScopeHash: "scope-safe",
      intent: "metric_query",
      outcome: "completed",
      evidenceStatus: "pass",
      toolNames: ["query_analytics"],
      recoveryOutcomes: [],
      citationValidation: "pending",
    })}\n`, "utf8");
    await writeFile(path.join(rootDir, "run-events.jsonl"), `${JSON.stringify({
      runId: "run-safe-1",
      type: "agent-stream-completed",
      latencyMs: 42,
      citationValidation: "pass",
      queryPreview: "Sensitive prompt",
    })}\n`, "utf8");
    await writeFile(path.join(rootDir, "tool-calls.jsonl"), `${JSON.stringify({
      runId: "run-safe-1",
      toolName: "query_analytics",
      input: { detected_by: "Alice" },
      outputSummary: "Sensitive ticket title",
      recovery: { queryFingerprint: "a".repeat(24) },
    })}\n`, "utf8");

    const overview = await loadAgentOperations({ rootDir, operation: "summary" });
    const detail = await loadAgentOperations({ rootDir, operation: "run", runId: overview.runs[0].runRef });

    expect(detail).toMatchObject({
      run: { runRef: expect.stringMatching(/^run-[a-f0-9]{16}$/), citationValidation: "pass", latencyMs: 42 },
      timeline: expect.any(Array),
    });
    const text = JSON.stringify(detail);
    expect(text).not.toContain("Sensitive prompt");
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("Sensitive ticket title");
    expect(text).not.toContain("run-safe-1");
    expect(text).not.toContain("thread-safe-1");
    expect(text).toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("promotes a typed stream terminal failure into the operational outcome", () => {
    const summary = summarizeRuns({
      summaries: [{
        runId: "run-stream-failed",
        outcome: "completed",
        evidenceStatus: "not_required",
        toolNames: [],
      }],
      events: [{
        runId: "run-stream-failed",
        type: "agent-stream-completed",
        terminalStatus: "failed",
        failureCode: "FINAL_STREAM_FAILED",
        citationValidation: "blocked",
      }],
    });

    expect(summary).toMatchObject({
      byOutcome: { failed: 1 },
      citationValidation: { blocked: 1 },
      topFailureCodes: [{ code: "FINAL_STREAM_FAILED", count: 1 }],
      runs: [{ outcome: "failed", failureCode: "FINAL_STREAM_FAILED" }],
    });
  });

  it("does not expose caller-controlled run IDs, thread IDs, or unapproved tool names", () => {
    const summary = summarizeRuns({
      summaries: [{
        runId: "person-Alice-ticket-123-secret",
        threadId: "thread-person-Alice-ticket-123-secret",
        actorScopeHash: "scope-safe",
        intent: "metric_query",
        outcome: "completed",
        evidenceStatus: "pass",
        toolNames: ["query_analytics", "person-Alice-ticket-123-secret"],
        recoveryOutcomes: [],
        citationValidation: "pending",
      }],
      events: [],
    });

    const text = JSON.stringify(summary);
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("ticket-123");
    expect(text).not.toContain("secret");
    expect(summary.runs[0]).toMatchObject({
      runRef: expect.stringMatching(/^run-[a-f0-9]{16}$/),
      toolNames: ["query_analytics"],
    });
    expect(summary.runs[0]).not.toHaveProperty("runId");
    expect(summary.runs[0]).not.toHaveProperty("threadId");
  });
});
