// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyCleanupPlan, buildCleanupPlan } from "../../../../scripts/lib/agentRuntimeCleanup.mjs";
import { createTestRuntime } from "./runtimeFixture";

describe("Agent Runtime retention cleanup", () => {
  it("is inspectable as a dry-run and only deletes an explicit immutable plan", async () => {
    const fixture = await createTestRuntime();
    try {
      const request = { schemaVersion: "1.0", messageId: "cleanup-msg-1", threadVersion: 0, message: { role: "user", text: "cleanup", artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true, eventProtocolVersion: "1.0" };
      const started = await fixture.runtime.startRun({ actor: fixture.alice, request });
      await fixture.runtime.cancelRun({ actor: fixture.alice, runId: started.runId, threadVersion: started.threadVersion, reasonCode: "cleanup-test" });
      const current = fixture.threadStore.getThread({ actor: fixture.alice, threadId: started.threadId });
      fixture.threadStore.updateThread({ actor: fixture.alice, threadId: started.threadId, threadVersion: current.threadVersion, patch: { deleted: true } });

      const cutoffs = {
        eventsBefore: "2026-07-15T00:00:00.000Z",
        checkpointsBefore: "2026-07-15T00:00:00.000Z",
        journalBefore: "2026-07-15T00:00:00.000Z",
        artifactsBefore: "2026-07-15T00:00:00.000Z",
        threadsBefore: "2026-07-15T00:00:00.000Z",
        auditBefore: "2026-07-15T00:00:00.000Z",
      };
      const plan = buildCleanupPlan({ db: fixture.runtimeDb.db, cutoffs });
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.counts).toMatchObject({ threads: 1, events: 2 });
      expect(fixture.runtimeDb.db.prepare("SELECT COUNT(*) FROM agent_threads WHERE thread_id=?").pluck().get(started.threadId)).toBe(1);

      const deleted = applyCleanupPlan({ db: fixture.runtimeDb.db, plan });
      expect(deleted).toMatchObject({ threads: 1, events: 2 });
      expect(fixture.runtimeDb.db.prepare("SELECT COUNT(*) FROM agent_threads WHERE thread_id=?").pluck().get(started.threadId)).toBe(0);
      expect(fixture.runtimeDb.db.prepare("SELECT COUNT(*) FROM agent_runs WHERE run_id=?").pluck().get(started.runId)).toBe(0);
    } finally {
      await fixture.runtime.stopBackgroundLoops();
      fixture.cleanup();
    }
  });
});
