// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

const actor = {
  actorId: "alice",
  authSessionId: "session-1",
  roles: ["qa"],
  scopes: {
    workspaceIds: ["DTSV_China"],
    projectIds: ["SP25"],
    teamIds: ["DTSV"],
    allowedObjectTypes: ["defect"],
    allowedPropertyIds: [],
    rowPolicyIds: ["dtsv"],
    sensitiveFieldPolicyIds: [],
  },
  scopeVersion: "scope-v1",
  scopeHash: "scope-a",
};

const bob = { ...actor, actorId: "bob", authSessionId: "session-2" };

describe("ThreadStore", () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeDbFixture>>;
  let nowMs: number;
  let id: number;
  let writes: unknown[];
  let store: ReturnType<typeof createThreadStore>;

  beforeEach(async () => {
    fixture = await createRuntimeDbFixture();
    nowMs = Date.parse("2026-07-14T00:00:00.000Z");
    id = 0;
    writes = [];
    store = createThreadStore({
      db: fixture.runtimeDb.db,
      now: () => new Date(nowMs).toISOString(),
      randomUUID: () => `id-${++id}`,
      writeEventsInTransaction: (_tx, events) => {
        writes.push(...events);
        return events;
      },
    });
  });

  afterEach(() => fixture.cleanup());

  it("creates actor-owned threads, messages and scoped reads", () => {
    const thread = store.createThread({ actor, title: "新对话" });
    expect(thread).toMatchObject({ threadId: "id-1", actorId: "alice", threadVersion: 0, title: "新对话" });

    const message = store.appendMessage({ actor, threadId: thread.threadId, messageId: "msg-1", role: "user", body: { text: "hello" }, scopeHash: actor.scopeHash });
    expect(message).toMatchObject({ messageId: "msg-1", threadId: thread.threadId, role: "user" });
    expect(store.listMessages({ actor, threadId: thread.threadId })).toHaveLength(1);
    expect(() => store.getThread({ actor: bob, threadId: thread.threadId })).toThrow(/NOT_FOUND/);
    expect(() => store.listMessages({ actor: bob, threadId: thread.threadId })).toThrow(/NOT_FOUND/);
  });

  it("creates idempotent runs and keeps one active run per thread", () => {
    const thread = store.createThread({ actor, title: "新对话" });
    const input = {
      actor,
      threadId: thread.threadId,
      expectedThreadVersion: 0,
      messageId: "msg-1",
      requestHash: "hash-a",
      graphDefinitionVersion: "main-agent-v1",
      runtimeMode: "langgraph",
      requestedModelId: "deepseek-v4-flash",
      actualModelId: "deepseek-v4-flash",
      modelConfigVersion: "test-v1",
      activeExecutionBudgetMs: 120000,
      hardExpiresAt: "2026-07-15T00:00:00.000Z",
    };

    const first = store.createRun(input);
    const retry = store.createRun(input);
    expect(retry.runId).toBe(first.runId);
    expect(() => store.createRun({ ...input, requestHash: "different" })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => store.createRun({ ...input, messageId: "msg-2", requestHash: "hash-b" })).toThrow(/THREAD_BUSY/);
    expect(() => store.getRun({ actor: bob, runId: first.runId })).toThrow(/NOT_FOUND/);
  });

  it("fences stale leases and state versions", () => {
    const thread = store.createThread({ actor, title: "新对话" });
    const created = store.createRun({
      actor,
      threadId: thread.threadId,
      expectedThreadVersion: 0,
      messageId: "msg-1",
      requestHash: "hash-a",
      graphDefinitionVersion: "main-agent-v1",
      runtimeMode: "langgraph",
      requestedModelId: "deepseek-v4-flash",
      actualModelId: "deepseek-v4-flash",
      modelConfigVersion: "test-v1",
      activeExecutionBudgetMs: 120000,
      hardExpiresAt: "2026-07-15T00:00:00.000Z",
    });

    const lease = store.claimRun({ runId: created.runId, workerId: "worker-a", leaseMs: 30000 });
    expect(() => store.claimRun({ runId: created.runId, workerId: "worker-b", leaseMs: 30000 })).toThrow(/RUN_LEASE_HELD/);
    nowMs += 30001;
    const replacement = store.claimRun({ runId: created.runId, workerId: "worker-b", leaseMs: 30000 });
    expect(replacement.leaseEpoch).toBe(lease.leaseEpoch + 1);
    expect(() => store.commitState({ runId: created.runId, expectedStateVersion: 0, leaseEpoch: lease.leaseEpoch, patch: { status: "running" } })).toThrow(/STALE_RUN_LEASE/);
    const committed = store.commitState({ runId: created.runId, expectedStateVersion: 0, leaseEpoch: replacement.leaseEpoch, patch: { status: "running" } });
    expect(committed).toMatchObject({ stateVersion: 1, status: "running" });
    expect(() => store.commitState({ runId: created.runId, expectedStateVersion: 0, leaseEpoch: replacement.leaseEpoch, patch: { status: "running" } })).toThrow(/STATE_VERSION_CONFLICT/);
  });
});