// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, alice, bob } from "./runtimeFixture";

const request = {
  schemaVersion: "1.0",
  messageId: "msg-1",
  threadVersion: 0,
  message: { role: "user", text: "六月有多少缺陷？", artifactRefs: [] },
  selectedModel: "deepseek-v4-flash",
  useDefectContext: false,
  useAnalyticsContext: true,
  eventProtocolVersion: "1.0",
};

describe("Agent Runtime", () => {
  let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
  beforeEach(async () => { fixture = await createTestRuntime(); });
  afterEach(() => fixture.cleanup());

  it("starts new-thread runs idempotently and rejects changed message bodies", async () => {
    const first = await fixture.runtime.startRun({ actor: alice, request });
    const retry = await fixture.runtime.startRun({ actor: alice, request });
    expect(retry).toMatchObject({ runId: first.runId, threadId: first.threadId, idempotentReplay: true });
    await expect(fixture.runtime.startRun({ actor: alice, request: { ...request, message: { ...request.message, text: "不同问题" } } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(() => fixture.threadStore.getRun({ actor: bob, runId: first.runId })).toThrow(/NOT_FOUND/);
  });

  it("cancels runs idempotently and writes one terminal event", async () => {
    const started = await fixture.runtime.startRun({ actor: alice, request });
    const cancelled = await fixture.runtime.cancelRun({ actor: alice, runId: started.runId, threadVersion: started.threadVersion, reasonCode: "user_stop" });
    expect(cancelled.status).toBe("cancelled");
    await expect(fixture.runtime.cancelRun({ actor: bob, runId: started.runId, threadVersion: cancelled.threadVersion, reasonCode: "user_stop" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const events = fixture.eventStore.listAfter({ actor: alice, runId: started.runId });
    expect(events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
  });
});