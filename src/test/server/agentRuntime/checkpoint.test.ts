// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { checkpointConfig, createCheckpointCoordinator } from "../../../../server/agentRuntime/checkpoint.mjs";

describe("Checkpoint coordinator", () => {
  it("builds explicit checkpoint configs and never asks for latest by accident", () => {
    expect(checkpointConfig({ threadId: "thread-1", checkpointId: "cp-1" })).toEqual({ configurable: { thread_id: "thread-1", checkpoint_ns: "", checkpoint_id: "cp-1" } });
    expect(checkpointConfig({ threadId: "thread-1" })).toEqual({ configurable: { thread_id: "thread-1", checkpoint_ns: "" } });
  });

  it("catches up committed transitions and promotes the exact candidate checkpoint", async () => {
    const graph = { getState: vi.fn().mockResolvedValue({ values: { count: 1 } }), updateState: vi.fn().mockResolvedValue({ configurable: { checkpoint_id: "candidate-2" } }) };
    const threadStore = { promoteCanonicalCheckpoint: vi.fn().mockResolvedValue({ canonicalCheckpointId: "candidate-2" }) };
    const coordinator = createCheckpointCoordinator({
      saver: { name: "fake-saver" },
      threadStore,
      graphDefinitionVersion: "main-agent-v1",
      projectCommittedTransitions: vi.fn((state) => ({ ...state, count: state.count + 1 })),
      hashState: vi.fn((state) => `hash-${state.count}`),
    });
    const run = { runId: "run-1", threadId: "thread-1", stateVersion: 5, leaseEpoch: 2, graphDefinitionVersion: "main-agent-v1", canonicalCheckpointId: "canonical-1" };

    await expect(coordinator.ensureCheckpointCaughtUp({ graph, run })).resolves.toMatchObject({ checkpointId: "candidate-2", stateHash: "hash-2" });

    expect(graph.getState).toHaveBeenCalledWith({ configurable: { thread_id: "thread-1", checkpoint_ns: "", checkpoint_id: "canonical-1" } });
    expect(graph.updateState).toHaveBeenCalledWith({ configurable: { thread_id: "thread-1", checkpoint_ns: "", checkpoint_id: "canonical-1" } }, { count: 2 });
    expect(threadStore.promoteCanonicalCheckpoint).toHaveBeenCalledWith({ runId: "run-1", expectedStateVersion: 5, leaseEpoch: 2, checkpointId: "candidate-2", stateHash: "hash-2" });
  });

  it("rejects progressed runs without canonical checkpoints and wrong graph versions", () => {
    const coordinator = createCheckpointCoordinator({ saver: {}, threadStore: {}, graphDefinitionVersion: "main-agent-v1", projectCommittedTransitions: (state) => state, hashState: () => "hash" });
    expect(coordinator.canonicalConfigForRun({ threadId: "thread-1", stateVersion: 0, graphDefinitionVersion: "main-agent-v1" })).toEqual({ configurable: { thread_id: "thread-1", checkpoint_ns: "" } });
    expect(() => coordinator.canonicalConfigForRun({ threadId: "thread-1", stateVersion: 1, graphDefinitionVersion: "main-agent-v1" })).toThrow(/CANONICAL_CHECKPOINT_MISSING/);
    expect(() => coordinator.canonicalConfigForRun({ threadId: "thread-1", stateVersion: 0, graphDefinitionVersion: "main-agent-v2" })).toThrow(/GRAPH_VERSION_MISMATCH/);
  });
});