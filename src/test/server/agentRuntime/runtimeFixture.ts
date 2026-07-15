// @vitest-environment node
import { createContractRegistry } from "../../../../server/agentRuntime/contracts.mjs";
import { createAuditStore } from "../../../../server/agentRuntime/audit.mjs";
import { createEventStore } from "../../../../server/agentRuntime/events.mjs";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";
import { createAgentRuntime } from "../../../../server/agentRuntime/runtime.mjs";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

export const alice = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };
export const bob = { ...alice, actorId: "bob", authSessionId: "s2", scopeHash: "scope-b" };

export async function createTestRuntime({ executeClaimedRun = async () => undefined } = {}) {
  const fixture = await createRuntimeDbFixture();
  let id = 0;
  let nowMs = Date.parse("2026-07-14T00:00:00.000Z");
  const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
  const contracts = createContractRegistry();
  const events = createEventStore({ db: fixture.runtimeDb.db, contracts, now: clock.now, randomUUID: () => `evt-${++id}`, authorizeRun: ({ actor, run }) => { if (actor.actorId !== run.actor_id) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND", statusCode: 404 }); } });
  const threadStore = createThreadStore({ db: fixture.runtimeDb.db, now: clock.now, randomUUID: () => `id-${++id}`, writeEventsInTransaction: events.writeInTransaction });
  const audit = createAuditStore({ db: fixture.runtimeDb.db, now: clock.now, randomUUID: () => `audit-${++id}` });
  const runtime = createAgentRuntime({ db: fixture.runtimeDb.db, contracts, threadStore, eventStore: events, auditStore: audit, policy: createRuntimePolicy(), now: clock.now, nowMs: clock.nowMs, randomUUID: () => `id-${++id}`, executeClaimedRun });
  return { ...fixture, runtime, threadStore, eventStore: events, auditStore: audit, clock, alice, bob, cleanup: fixture.cleanup };
}