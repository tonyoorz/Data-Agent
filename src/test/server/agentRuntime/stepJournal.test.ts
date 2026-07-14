// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEventStore } from "../../../../server/agentRuntime/events.mjs";
import { createContractRegistry } from "../../../../server/agentRuntime/contracts.mjs";
import { createStepJournal, hashStepInput } from "../../../../server/agentRuntime/stepJournal.mjs";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

const actor = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };

async function setupJournalFixture({ boundaryKind = "read" } = {}) {
  const fixture = await createRuntimeDbFixture();
  let id = 0;
  const events = createEventStore({ db: fixture.runtimeDb.db, contracts: createContractRegistry(), now: () => "2026-07-14T00:00:00.000Z", randomUUID: () => `evt-${++id}`, authorizeRun: ({ actor: currentActor, run }) => { if (run.actor_id !== currentActor.actorId) throw new Error("NOT_FOUND"); } });
  const threadStore = createThreadStore({ db: fixture.runtimeDb.db, now: () => "2026-07-14T00:00:00.000Z", randomUUID: () => `id-${++id}`, writeEventsInTransaction: events.writeInTransaction });
  const thread = threadStore.createThread({ actor, title: "新对话" });
  const run = threadStore.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-a", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
  const lease = threadStore.claimRun({ runId: run.runId, workerId: "worker-a", leaseMs: 30000 });
  const journal = createStepJournal({ db: fixture.runtimeDb.db, threadStore, now: () => "2026-07-14T00:00:00.000Z" });
  const input = { runId: run.runId, nodeId: "execute_tool", logicalAttempt: 1, boundaryKind, graphDefinitionVersion: "main-agent-v1", scopeHash: actor.scopeHash, sourceRevisionSet: { analytics: { revisionId: "r1" } }, input: { filters: { years: "2026" } }, leaseEpoch: lease.leaseEpoch };
  return { fixture, journal, input, threadStore, run, lease };
}

describe("StepJournal", () => {
  it("includes graph version, refreshed scope and source revisions in the stable key", () => {
    const common = { graphDefinitionVersion: "main-agent-v1", scopeHash: "scope-a", sourceRevisionSet: { analytics: { revisionId: "r1" } }, input: { filters: { years: "2026" } } };
    expect(hashStepInput(common)).not.toBe(hashStepInput({ ...common, scopeHash: "scope-b" }));
    expect(hashStepInput(common)).not.toBe(hashStepInput({ ...common, graphDefinitionVersion: "main-agent-v2" }));
    expect(hashStepInput(common)).not.toBe(hashStepInput({ ...common, sourceRevisionSet: { analytics: { revisionId: "r2" } } }));
  });

  it("returns a committed result instead of repeating an external call", async () => {
    const { fixture, journal, input } = await setupJournalFixture();
    try {
      const execute = vi.fn().mockResolvedValue({ rows: 3 });
      await expect(journal.run(input, execute)).resolves.toEqual({ rows: 3 });
      await expect(journal.run(input, execute)).resolves.toEqual({ rows: 3 });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("blocks concurrent in-progress work and marks uncertain writes unknown", async () => {
    const { fixture, journal, input } = await setupJournalFixture({ boundaryKind: "write" });
    try {
      fixture.runtimeDb.db.prepare("INSERT INTO agent_step_journal(run_id,node_id,logical_attempt,input_hash,scope_hash,graph_definition_version,lease_epoch,status,started_at) VALUES(?,?,?,?,?,?,?,'started',?)").run(input.runId, input.nodeId, input.logicalAttempt, hashStepInput(input), input.scopeHash, input.graphDefinitionVersion, input.leaseEpoch, "2026-07-14T00:00:00.000Z");
      await expect(journal.run(input, vi.fn())).rejects.toMatchObject({ code: "STEP_IN_PROGRESS" });
      fixture.runtimeDb.db.prepare("UPDATE agent_step_journal SET status='unknown' WHERE run_id=?").run(input.runId);
      await expect(journal.run(input, vi.fn())).rejects.toMatchObject({ code: "STEP_REQUIRES_RECONCILIATION" });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not let stale workers record failed steps", async () => {
    const { fixture, journal, input } = await setupJournalFixture();
    try {
      await expect(journal.run({ ...input, leaseEpoch: input.leaseEpoch + 1 }, vi.fn().mockRejectedValue(new Error("boom")))).rejects.toMatchObject({ code: "STALE_RUN_LEASE" });
      expect(fixture.runtimeDb.db.prepare("SELECT status FROM agent_step_journal WHERE run_id=?").pluck().get(input.runId)).toBe("started");
    } finally {
      fixture.cleanup();
    }
  });
});