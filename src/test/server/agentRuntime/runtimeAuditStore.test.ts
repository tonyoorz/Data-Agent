import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createFileAgentRuntimeStore } from "../../../../server/agentRuntime/runtimeAuditStore.mjs";

describe("file agent runtime store", () => {
  it("persists thread checkpoints, run audit events, and tool-call audit records", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "vizion-agent-runtime-"));
    const clientThreadId = "client-thread-alice@example.test";
    await chmod(rootDir, 0o755);
    const store = createFileAgentRuntimeStore({
      rootDir,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    await store.writeThreadCheckpoint({
      persistenceKey: `actor-thread-${"1".repeat(64)}`,
      threadId: clientThreadId,
      runId: "run-1",
      actorScope: { actorId: "u1", scopeHash: "scope-1", scopes: { projectIds: ["App"] } },
      checkpoint: {
        node: "finalize",
        queryText: "sensitive defect title",
        metrics: {
          actorId: "u1",
          queryText: "sensitive defect title",
          mainAgentToolCallCount: 1,
          evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snapshot-1"] },
        },
      },
    });
    await store.writeThreadCheckpoint({
      persistenceKey: `actor-thread-${"2".repeat(64)}`,
      threadId: clientThreadId,
      runId: "run-2",
      actorScope: { actorId: "u2", scopeHash: "scope-2", scopes: { projectIds: ["App"] } },
      checkpoint: { node: "finalize", metrics: { mainAgentToolCallCount: 0 } },
    });
    await store.appendRunEvent({ runId: "run-1", threadId: clientThreadId, type: "agent-runtime-ready" });
    await store.appendToolAudit({
      runId: "run-1",
      threadId: clientThreadId,
      actorScope: { actorId: "u1", scopeHash: "scope-1" },
      toolCallId: "call-1",
      toolName: "query_semantic_metrics",
      input: { query: { intent: "rank" } },
      outputSummary: "# Main agent semantic tool result",
      privateStack: "Error: bearer-token-secret\n at private.js:1:1",
    });
    await store.appendRunSummary({
      schemaVersion: "1.0",
      runId: "run-1",
      threadId: clientThreadId,
      actorScopeHash: "scope-1",
      intent: "metric_query",
      outcome: "completed",
    });

    const checkpoint = JSON.parse(
      await readFile(path.join(rootDir, "threads", `actor-thread-${"1".repeat(64)}.json`), "utf8"),
    );
    expect(checkpoint).toEqual(
      expect.objectContaining({
        threadRef: expect.stringMatching(/^thread-[a-f0-9]{64}$/),
        runId: "run-1",
        actorScopeHash: "scope-1",
        checkpoint: {
          node: "finalize",
          metrics: {
            mainAgentToolCallCount: 1,
            evidenceGate: { status: "pass", violations: [], sourceRevisionIds: ["snapshot-1"] },
          },
        },
        updatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );
    const otherActorCheckpoint = JSON.parse(
      await readFile(path.join(rootDir, "threads", `actor-thread-${"2".repeat(64)}.json`), "utf8"),
    );
    expect(otherActorCheckpoint).toEqual(expect.objectContaining({
      threadRef: expect.stringMatching(/^thread-[a-f0-9]{64}$/),
      runId: "run-2",
      actorScopeHash: "scope-2",
    }));
    expect(otherActorCheckpoint.threadRef).not.toBe(checkpoint.threadRef);

    const runEvents = (await readFile(path.join(rootDir, "run-events.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(runEvents[0])).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadRef: expect.stringMatching(/^thread-[a-f0-9]{64}$/),
        type: "agent-runtime-ready",
        recordedAt: "2026-07-24T08:00:00.000Z",
      }),
    );

    const toolAudit = (await readFile(path.join(rootDir, "tool-calls.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(toolAudit[0])).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadRef: expect.stringMatching(/^thread-[a-f0-9]{64}$/),
        toolCallId: "call-1",
        toolName: "query_semantic_metrics",
        actorScopeHash: "scope-1",
      }),
    );
    expect(JSON.parse(toolAudit[0])).not.toHaveProperty("input");
    expect(JSON.parse(toolAudit[0])).not.toHaveProperty("outputSummary");
    expect(JSON.parse(toolAudit[0])).not.toHaveProperty("privateStack");

    const runSummary = (await readFile(path.join(rootDir, "run-summaries.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(runSummary[0])).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadRef: expect.stringMatching(/^thread-[a-f0-9]{64}$/),
        actorScopeHash: "scope-1",
        intent: "metric_query",
        outcome: "completed",
        recordedAt: "2026-07-24T08:00:00.000Z",
      }),
    );

    const persistedText = [
      await readFile(path.join(rootDir, "threads", `actor-thread-${"1".repeat(64)}.json`), "utf8"),
      await readFile(path.join(rootDir, "run-events.jsonl"), "utf8"),
      await readFile(path.join(rootDir, "tool-calls.jsonl"), "utf8"),
      await readFile(path.join(rootDir, "run-summaries.jsonl"), "utf8"),
    ].join("\n");
    expect(persistedText).not.toContain("sensitive defect title");
    expect(persistedText).not.toContain("bearer-token-secret");
    expect(persistedText).not.toContain('"actorId"');
    expect(persistedText).not.toContain('"projectIds"');
    expect(persistedText).not.toContain(clientThreadId);
    expect(persistedText).not.toContain('"threadId"');

    expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(rootDir, "threads"))).mode & 0o777).toBe(0o700);
    for (const relativePath of [
      `threads/actor-thread-${"1".repeat(64)}.json`,
      `threads/actor-thread-${"2".repeat(64)}.json`,
      "run-events.jsonl",
      "tool-calls.jsonl",
      "run-summaries.jsonl",
    ]) {
      expect((await stat(path.join(rootDir, relativePath))).mode & 0o777).toBe(0o600);
    }
  });
});
