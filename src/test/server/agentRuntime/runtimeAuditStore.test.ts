import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createFileAgentRuntimeStore } from "../../../../server/agentRuntime/runtimeAuditStore.mjs";

describe("file agent runtime store", () => {
  it("persists thread checkpoints, run audit events, and tool-call audit records", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "vizion-agent-runtime-"));
    const store = createFileAgentRuntimeStore({
      rootDir,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
    });

    await store.writeThreadCheckpoint({
      threadId: "thread/one",
      runId: "run-1",
      actorScope: { actorId: "u1", scopeHash: "scope-1", scopes: { projectIds: ["App"] } },
      checkpoint: { node: "finalize", metrics: { mainAgentToolCallCount: 1 } },
    });
    await store.appendRunEvent({ runId: "run-1", threadId: "thread/one", type: "agent-runtime-ready" });
    await store.appendToolAudit({
      runId: "run-1",
      threadId: "thread/one",
      actorScope: { actorId: "u1", scopeHash: "scope-1" },
      toolCallId: "call-1",
      toolName: "query_semantic_metrics",
      input: { query: { intent: "rank" } },
      outputSummary: "# Main agent semantic tool result",
    });

    const checkpoint = JSON.parse(await readFile(path.join(rootDir, "threads", "thread_one.json"), "utf8"));
    expect(checkpoint).toEqual(
      expect.objectContaining({
        threadId: "thread/one",
        runId: "run-1",
        actorScope: { actorId: "u1", scopeHash: "scope-1", scopes: { projectIds: ["App"] } },
        checkpoint: { node: "finalize", metrics: { mainAgentToolCallCount: 1 } },
        updatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );

    const runEvents = (await readFile(path.join(rootDir, "run-events.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(runEvents[0])).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread/one",
        type: "agent-runtime-ready",
        recordedAt: "2026-07-24T08:00:00.000Z",
      }),
    );

    const toolAudit = (await readFile(path.join(rootDir, "tool-calls.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(toolAudit[0])).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread/one",
        toolCallId: "call-1",
        toolName: "query_semantic_metrics",
        actorScope: { actorId: "u1", scopeHash: "scope-1" },
      }),
    );
  });
});