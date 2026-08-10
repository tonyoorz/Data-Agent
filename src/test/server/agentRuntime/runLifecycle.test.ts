// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

const actor = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };

describe("Run lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeDbFixture>>;
  let nowMs: number;
  let id: number;
  let writes: unknown[];
  let store: ReturnType<typeof createThreadStore>;
  let runId: string;
  let threadId: string;
  let leaseEpoch: number;

  beforeEach(async () => {
    fixture = await createRuntimeDbFixture();
    nowMs = Date.parse("2026-07-14T00:00:00.000Z");
    id = 0;
    writes = [];
    store = createThreadStore({
      db: fixture.runtimeDb.db,
      now: () => new Date(nowMs).toISOString(),
      randomUUID: () => `id-${++id}`,
      writeEventsInTransaction: (_tx, input) => {
        const eventInputs = Array.isArray(input) ? input : input.eventInputs;
        writes.push(...eventInputs);
        return eventInputs;
      },
    });
    const thread = store.createThread({ actor, title: "新对话" });
    threadId = thread.threadId;
    const run = store.createRun({ actor, threadId, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-a", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
    runId = run.runId;
    leaseEpoch = store.claimRun({ runId, workerId: "worker-a", leaseMs: 30000 }).leaseEpoch;
  });

  afterEach(() => fixture.cleanup());

  it("consumes a clarification once and rejects changed retries", () => {
    const interaction = store.createInteraction({ actor, runId, leaseEpoch, kind: "clarification", payload: { question: "哪个项目？" }, expiresAt: "2026-07-14T00:10:00.000Z" });
    const consumed = store.consumeInteraction({ actor, runId, interactionId: interaction.interactionId, threadVersion: 1, value: { project: "SP25" } });
    expect(consumed).toMatchObject({ status: "consumed", result: { project: "SP25" } });
    expect(() => store.consumeInteraction({ actor, runId, interactionId: interaction.interactionId, threadVersion: 1, value: { project: "SP25" } })).toThrow(/THREAD_VERSION_CONFLICT/);
    expect(store.consumeInteraction({ actor, runId, interactionId: interaction.interactionId, threadVersion: 2, value: { project: "SP25" } })).toMatchObject({ status: "consumed" });
    expect(() => store.consumeInteraction({ actor, runId, interactionId: interaction.interactionId, threadVersion: 2, value: { project: "SP26" } })).toThrow(/INTERACTION_ALREADY_CONSUMED/);
  });

  it("cancels waiting runs idempotently and writes terminal events", () => {
    const interaction = store.createInteraction({ actor, runId, leaseEpoch, kind: "clarification", payload: { question: "哪个项目？" }, expiresAt: "2026-07-14T00:10:00.000Z" });
    expect(() => store.cancelRun({ actor, runId, threadVersion: 0, reasonCode: "user_stop" })).toThrow(/THREAD_VERSION_CONFLICT/);
    const cancelled = store.cancelRun({ actor, runId, threadVersion: 1, reasonCode: "user_stop" });
    expect(cancelled.status).toBe("cancelled");
    expect(writes).toContainEqual(expect.objectContaining({ type: "run.cancelled" }));
    expect(() => store.cancelRun({ actor, runId, threadVersion: 1, reasonCode: "user_stop" })).toThrow(/THREAD_VERSION_CONFLICT/);
    expect(store.cancelRun({ actor, runId, threadVersion: 2, reasonCode: "user_stop" }).status).toBe("cancelled");
    expect(fixture.runtimeDb.db.prepare("SELECT status FROM agent_interactions WHERE interaction_id=?").pluck().get(interaction.interactionId)).toBe("cancelled");

    const second = store.createRun({ actor, threadId, expectedThreadVersion: 2, messageId: "msg-2", requestHash: "hash-b", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
    const secondLease = store.claimRun({ runId: second.runId, workerId: "worker-a", leaseMs: 30000 });
    expect(secondLease.leaseEpoch).toBeGreaterThan(0);
    expect(() => store.completeRun({ actor, runId: second.runId, threadVersion: 1, answer: { answerId: "a2" }, assistantMessageId: "assistant-2", durationMs: 5 })).toThrow(/THREAD_VERSION_CONFLICT/);
    expect(store.completeRun({ actor, runId: second.runId, threadVersion: 2, answer: { answerId: "a2" }, assistantMessageId: "assistant-2", durationMs: 5 }).status).toBe("completed");

    const third = store.createRun({ actor, threadId, expectedThreadVersion: 3, messageId: "msg-3", requestHash: "hash-c", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
    store.claimRun({ runId: third.runId, workerId: "worker-a", leaseMs: 30000 });
    expect(() => store.failRun({ actor, runId: third.runId, threadVersion: 2, error: { code: "X", safeMessage: "x", retryable: false } })).toThrow(/THREAD_VERSION_CONFLICT/);
  });

  it("requires terminal transitions to use the event writer", async () => {
    const noWriter = createThreadStore({ db: fixture.runtimeDb.db, now: () => new Date(nowMs).toISOString(), randomUUID: () => `x-${++id}` });
    expect(() => noWriter.completeRun({ actor, runId, leaseEpoch, answer: { answerId: "a1" }, assistantMessageId: "assistant-1", threadVersion: 1, durationMs: 5 })).toThrow(/EVENT_WRITER_REQUIRED/);
  });
});