// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContractRegistry } from "../../../../server/agentRuntime/contracts.mjs";
import { createEventStore, mapEventToLegacy } from "../../../../server/agentRuntime/events.mjs";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

const actor = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };
const bob = { ...actor, actorId: "bob" };

describe("Agent event outbox", () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeDbFixture>>;
  let events: ReturnType<typeof createEventStore>;
  let store: ReturnType<typeof createThreadStore>;
  let run: { runId: string; threadId: string; stateVersion: number; leaseEpoch: number };
  let id = 0;

  beforeEach(async () => {
    fixture = await createRuntimeDbFixture();
    events = createEventStore({
      db: fixture.runtimeDb.db,
      contracts: createContractRegistry(),
      now: () => "2026-07-14T00:00:00.000Z",
      randomUUID: () => `evt-${++id}`,
      authorizeRun: ({ actor: currentActor, run }) => {
        if (run.actor_id !== currentActor.actorId) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND", statusCode: 404 });
      },
    });
    store = createThreadStore({
      db: fixture.runtimeDb.db,
      now: () => "2026-07-14T00:00:00.000Z",
      randomUUID: () => `id-${++id}`,
      writeEventsInTransaction: events.writeInTransaction,
    });
    const thread = store.createThread({ actor, title: "新对话" });
    const created = store.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-a", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
    run = store.claimRun({ runId: created.runId, workerId: "worker-1", leaseMs: 30000 });
  });

  afterEach(() => fixture.cleanup());

  it("allocates one monotonic sequence and rejects a second terminal event", () => {
    const [started] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] });
    expect(started).toMatchObject({ sequence: 1, stateVersion: 1, type: "tool.started" });
    const [failed] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, patch: { status: "failed" }, eventInputs: [{ type: "run.failed", payload: { code: "X", safeMessage: "x", retryable: false, threadVersion: 1 } }] });
    expect(failed.sequence).toBe(2);
    expect(() => events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 2, leaseEpoch: run.leaseEpoch, patch: { status: "failed" }, eventInputs: [{ type: "run.failed", payload: { code: "Y", safeMessage: "y", retryable: false, threadVersion: 1 } }] })).toThrow(/TERMINAL_EVENT_EXISTS|RUN_ALREADY_TERMINAL/);
  });

  it("replays strictly after Last-Event-ID and keeps legacy profile mapping exclusive", () => {
    const [first] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] });
    const [second] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "answer.delta", payload: { answerId: "answer-1", contentHash: "hash", offset: 0, text: "答案" } }] });

    const replay = events.listAfter({ runId: run.runId, afterEventId: first.eventId, actor });
    expect(replay.map((event) => event.eventId)).toEqual([second.eventId]);
    expect(replay.map((event) => event.sequence)).toEqual([2]);
    expect(mapEventToLegacy(replay[0], { resolveToolName: () => "query_dashboard_summary" })).toEqual({ choices: [{ delta: { content: "答案" } }] });
    expect(() => events.listAfter({ runId: run.runId, afterEventId: second.eventId, actor: bob })).toThrow(/NOT_FOUND/);
    expect(() => events.listAfter({ runId: run.runId, afterEventId: "evt-forged", actor })).toThrow(/INVALID_EVENT_CURSOR/);
  });

  it("uses UTF-8 byte offsets for persisted answer chunks", () => {
    const terminal = events.appendAnswer({
      actor,
      runId: run.runId,
      expectedStateVersion: 0,
      leaseEpoch: run.leaseEpoch,
      assistantMessageId: "assistant-1",
      threadVersion: 0,
      durationMs: 10,
      maxChunkCharacters: 1,
      answer: { schemaVersion: "1.0", answerId: "answer-1", text: "中文A", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} },
    });
    expect(terminal.type).toBe("run.completed");
    const chunks = events.listAfter({ runId: run.runId, actor }).filter((event) => event.type === "answer.delta");
    expect(chunks.map((event) => event.payload.offset)).toEqual([0, 3, 6]);
    expect(Buffer.byteLength(chunks.map((item) => item.payload.text).join(""), "utf8")).toBe(7);
    expect(store.listMessages({ actor, threadId: run.threadId }).at(-1)).toMatchObject({ messageId: "assistant-1", role: "assistant" });
    expect(() => events.appendAnswer({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, assistantMessageId: "assistant-1", threadVersion: 0, durationMs: -1, maxChunkCharacters: 1, answer: { schemaVersion: "1.0", answerId: "answer-1", text: "中文A", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } })).toThrow(/INVALID_RUN_DURATION|THREAD_VERSION_CONFLICT/);
    expect(events.appendAnswer({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, assistantMessageId: "assistant-1", threadVersion: 1, durationMs: 10, maxChunkCharacters: 1, answer: { schemaVersion: "1.0", answerId: "answer-1", text: "中文A", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } })).toMatchObject({ type: "run.completed" });
  });

  it("rejects stale leases, state conflicts and unknown event types", () => {
    expect(() => events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch + 1, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] })).toThrow(/STALE_RUN_LEASE/);
    events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] });
    expect(() => events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a2", stepId: "s2", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] })).toThrow(/STATE_VERSION_CONFLICT/);
    expect(() => events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "made.up", payload: {} }] })).toThrow(/INVALID_AGENT_EVENT/);
  });
});