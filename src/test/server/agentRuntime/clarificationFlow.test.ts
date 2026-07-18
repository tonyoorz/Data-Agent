// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { startLocalAgentHarness } from "../../../../scripts/lib/agentRuntimeHarness.mjs";

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("WAIT_FOR_TIMEOUT");
}

describe("focused clarification lifecycle", () => {
  let harness: Awaited<ReturnType<typeof startLocalAgentHarness>> | undefined;
  afterEach(async () => harness?.cleanup());

  it("pauses a draft metric, validates the reply, and resumes with an approved metric", async () => {
    harness = await startLocalAgentHarness();
    const startResponse = await fetch(`${harness.baseUrl}/api/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1.0",
        messageId: "clarification-msg-1",
        threadVersion: 0,
        message: { role: "user", text: "DTSV 的缺陷密度是多少", artifactRefs: [] },
        selectedModel: "fake-certified",
        useDefectContext: false,
        useAnalyticsContext: true,
        eventProtocolVersion: "1.0",
      }),
    });
    expect(startResponse.status).toBe(202);
    const started = await startResponse.json();

    const waiting = await waitFor(
      () => harness!.deps.threadStore.getRun({ actor: harness!.actor, runId: started.runId }),
      (run) => run.status === "waiting_for_clarification",
    );
    expect(waiting.answer).toBeNull();
    const events = harness.deps.eventStore.listAfter({ actor: harness.actor, runId: started.runId });
    const clarification = events.find((event) => event.type === "clarification.required");
    expect(clarification?.payload.question).toContain("口径尚未批准");
    expect(events.some((event) => event.type === "tool.started")).toBe(false);

    const invalidResponse = await fetch(`${harness.baseUrl}/api/agent/runs/${started.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", interactionId: clarification!.payload.interactionId, threadVersion: clarification!.payload.threadVersion, value: { selection: "任意猜测" } }),
    });
    expect(invalidResponse.status).toBe(400);

    const resumeResponse = await fetch(`${harness.baseUrl}/api/agent/runs/${started.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", interactionId: clarification!.payload.interactionId, threadVersion: clarification!.payload.threadVersion, value: { selection: "改用已批准指标 (defect.count)" } }),
    });
    expect(resumeResponse.status).toBe(202);

    const completed = await waitFor(
      () => harness!.deps.threadStore.getRun({ actor: harness!.actor, runId: started.runId }),
      (run) => run.status === "completed",
    );
    expect(completed.answer.groundingStatus).toBe("grounded");
    expect(completed.answer.text).toContain("缺陷数为 42");
    const finalEvents = harness.deps.eventStore.listAfter({ actor: harness.actor, runId: started.runId });
    expect(finalEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["clarification.required", "run.resumed", "tool.started", "run.completed"]));
    expect(finalEvents.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))).toHaveLength(1);
    expect(harness.states.get(started.runId)?.semanticFrame.metricIds).toEqual(["defect.count"]);
  });
});
