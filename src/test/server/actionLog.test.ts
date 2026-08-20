// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";
import { createActionRuntime, createInMemoryWriteStore } from "../../../server/agentRuntime/actionRuntime.mjs";
import { createSessionEventLog } from "../../../server/agentRuntime/sessionEventLog.mjs";

const registry = createOntologyRegistry();
const UPDATE_STATUS = "quality.defect.update_status";

function buildRuntime({ failOn, readBeforeValues } = {}) {
  const eventLog = createSessionEventLog();
  const writeStore = createInMemoryWriteStore({ failOn });
  const runtime = createActionRuntime({ registry, eventLog, writeStore, readBeforeValues });
  return { runtime, writeStore, eventLog };
}

const actor = { actorId: "alice", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };

describe("Action Log audit objects (P1-C3)", () => {
  it("ontology declares quality.action_log with full audit fields", () => {
    const entity = registry.bundle.entities.find((e) => e.id === "quality.action_log");
    expect(entity).toBeTruthy();
    expect(entity.primaryKey).toBe("log_rid");
    const propertyIds = entity.properties.map((p) => p.id);
    for (const required of [
      "log_rid", "action_rid", "action_version", "committed_at",
      "actor_id", "approver", "target_entity", "target_key", "diff", "status",
    ]) {
      expect(propertyIds).toContain(required);
    }
  });

  it("generates a [LOG] object with complete fields after an approved writeback", async () => {
    const before = { status: "Open" };
    const { runtime } = buildRuntime({ readBeforeValues: async () => before });
    const submission = await runtime.submitAction({
      actionId: UPDATE_STATUS,
      payload: { defect_id: "DEF-42", status: "Closed" },
      actor,
    });
    const decided = await runtime.decide({
      submissionId: submission.submissionId,
      decision: "approved",
      decidedBy: "tony",
    });
    expect(decided.status).toBe("executed");
    expect(decided.logRid).toMatch(/^log_/);

    const entry = runtime.getLogByRid(decided.logRid);
    expect(entry).toBeTruthy();
    expect(entry.action_rid).toBe(UPDATE_STATUS);
    expect(entry.action_version).toBe("1.0.0");
    expect(entry.actor_id).toBe("alice");
    expect(entry.approver).toBe("tony");
    expect(entry.target_entity).toBe("quality.defect");
    expect(entry.target_key).toBe("DEF-42");
    expect(entry.status).toBe("committed");
    const diff = JSON.parse(entry.diff);
    expect(diff.status).toEqual({ before: "Open", after: "Closed" });
    expect(diff.resolution_time).toEqual({ before: null, after: null });
  });

  it("queryLog returns newest-first timeline and filters by entity/since", async () => {
    let tick = 0;
    const now = () => new Date(Date.parse("2026-08-20T03:00:00Z") + tick++ * 60000);
    const { runtime } = buildRuntime({ now });
    for (const defectId of ["DEF-1", "DEF-2", "DEF-3"]) {
      const submission = await runtime.submitAction({
        actionId: UPDATE_STATUS,
        payload: { defect_id: defectId, status: "Closed" },
        actor,
        sessionId: `s-${defectId}`,
      });
      await runtime.decide({ submissionId: submission.submissionId, decision: "approved", decidedBy: "tony" });
    }
    const timeline = runtime.queryLog({ entity: "quality.defect" });
    expect(timeline).toHaveLength(3);
    expect(timeline[0].target_key).toBe("DEF-3");
    expect(timeline[2].target_key).toBe("DEF-1");

    // since boundary = DEF-2's commit time → newest two, inclusive
    const since = runtime.queryLog({ since: timeline[1].committed_at });
    expect(since.map((e) => e.target_key)).toEqual(["DEF-3", "DEF-2"]);

    expect(runtime.queryLog({ entity: "organization.team" })).toHaveLength(0);
  });

  it("rollback failures never produce log objects", async () => {
    const { runtime } = buildRuntime({ failOn: (dataset) => dataset === "analytics.defect_writeback" });
    const submission = await runtime.submitAction({
      actionId: UPDATE_STATUS,
      payload: { defect_id: "DEF-9", status: "Closed" },
      actor,
    });
    const decided = await runtime.decide({ submissionId: submission.submissionId, decision: "approved" });
    expect(decided.status).toBe("failed_rolled_back");
    expect(runtime.queryLog({})).toHaveLength(0);
  });
});
