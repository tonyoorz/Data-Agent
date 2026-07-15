// @vitest-environment node
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestRuntime, alice } from "./runtimeFixture";

const request = {
  schemaVersion: "1.0",
  messageId: "msg-recovery-1",
  threadVersion: 0,
  message: { role: "user", text: "六月有多少缺陷？", artifactRefs: [] },
  selectedModel: "deepseek-v4-flash",
  useDefectContext: false,
  useAnalyticsContext: true,
  eventProtocolVersion: "1.0",
};

describe("Runtime recovery placeholders", () => {
  it("exposes recovery and reaper public methods", async () => {
    const fixture = await createTestRuntime();
    try {
      expect(typeof fixture.runtime.recoverRun).toBe("function");
      expect(typeof fixture.runtime.reapExpiredWork).toBe("function");
    } finally {
      fixture.cleanup();
    }
  });

  it("recovers an expired active run lease and schedules execution", async () => {
    const executeClaimedRun = vi.fn().mockResolvedValue(undefined);
    const fixture = await createTestRuntime({ executeClaimedRun });
    try {
      const started = await fixture.runtime.startRun({ actor: alice, request });
      executeClaimedRun.mockClear();
      fixture.clock.advance(30001);

      const recovered = await fixture.runtime.recoverRun({ runId: started.runId, workerId: "worker-recovery" });

      expect(recovered).toMatchObject({ runId: started.runId, status: "running" });
      expect(executeClaimedRun).toHaveBeenCalledWith(expect.objectContaining({ runId: started.runId, actor: expect.objectContaining({ actorId: "alice" }) }));
    } finally {
      fixture.cleanup();
    }
  });

  it("reaps expired interactions into a terminal failure", async () => {
    const fixture = await createTestRuntime();
    try {
      const started = await fixture.runtime.startRun({ actor: alice, request: { ...request, messageId: "msg-reaper-1" } });
      const run = fixture.threadStore.getRun({ actor: alice, runId: started.runId });
      fixture.threadStore.createInteraction({ actor: alice, runId: started.runId, leaseEpoch: run.leaseEpoch, kind: "clarification", payload: { question: "Which project?" }, expiresAt: "2026-07-13T23:59:00.000Z" });

      const result = await fixture.runtime.reapExpiredWork();

      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ runId: started.runId, code: "INTERACTION_EXPIRED" })]));
      expect(fixture.threadStore.getRun({ actor: alice, runId: started.runId }).status).toBe("failed");
      const events = fixture.eventStore.listAfter({ actor: alice, runId: started.runId });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["interaction.expired", "run.failed"]));
    } finally {
      fixture.cleanup();
    }
  });
});