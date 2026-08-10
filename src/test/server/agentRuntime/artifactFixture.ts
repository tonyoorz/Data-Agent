// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactStore } from "../../../../server/agentRuntime/artifactStore.mjs";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

export const actor = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };
export const otherActor = { ...actor, actorId: "bob", authSessionId: "s2", scopeHash: "scope-b" };

export async function setupArtifactFixture(limits = {}) {
  const fixture = await createRuntimeDbFixture();
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  let id = 0;
  const storeForThreads = createThreadStore({ db: fixture.runtimeDb.db, now: () => "2026-07-14T00:00:00.000Z", randomUUID: () => `id-${++id}`, writeEventsInTransaction: (_tx, events) => events });
  const thread = storeForThreads.createThread({ actor, title: "新对话" });
  const otherThread = storeForThreads.createThread({ actor: otherActor, title: "Other" });
  const run = storeForThreads.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-a", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
  const store = createArtifactStore({ db: fixture.runtimeDb.db, artifactRoot, now: () => "2026-07-14T00:00:00.000Z", randomUUID: () => `artifact-${++id}`, limits });
  return {
    store,
    actor,
    otherActor,
    threadId: thread.threadId,
    otherThreadId: otherThread.threadId,
    runId: run.runId,
    artifactRoot,
    cleanup() {
      fixture.cleanup();
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    },
  };
}