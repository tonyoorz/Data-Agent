// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_MODEL_ID, fetchWithTimeout, startLocalAgentHarness } from "../../../../scripts/lib/agentRuntimeHarness.mjs";

describe("Main Agent thread semantic context", () => {
  let harness: Awaited<ReturnType<typeof startLocalAgentHarness>> | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("persists validated frames and inherits metric, time, and filters across three Runs", async () => {
    harness = await startLocalAgentHarness();
    let sequence = 0;

    async function run(text: string, threadId?: string) {
      const threadVersion = threadId
        ? harness!.deps.threadStore.getThread({ actor: harness!.actor, threadId }).threadVersion
        : 0;
      const response = await fetchWithTimeout(`${harness!.baseUrl}/api/agent/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "1.0",
          messageId: `message-${++sequence}`,
          ...(threadId ? { threadId } : {}),
          threadVersion,
          message: { role: "user", text, artifactRefs: [] },
          selectedModel: FAKE_MODEL_ID,
          useDefectContext: false,
          useAnalyticsContext: true,
          eventProtocolVersion: "1.0",
        }),
      });
      expect(response.status).toBe(202);
      const started = await response.json();
      const stream = await fetchWithTimeout(`${harness!.baseUrl}${started.eventsUrl}?follow=1`, { headers: { accept: 'text/event-stream; profile="agent-v1"' } });
      expect(stream.status).toBe(200);
      expect(await stream.text()).toContain("run.completed");
      return { ...started, state: harness!.states.get(started.runId) };
    }

    const first = await run("OS9 上月缺陷数？");
    const second = await run("那 OS8 呢？", first.threadId);
    const third = await run("按 ECU 排名前五。", first.threadId);

    expect(second.state.semanticFrame).toMatchObject({ metricIds: ["defect.count"], timeScopes: [{ start: "2026-06-01", end: "2026-06-30" }] });
    expect(second.state.semanticFrame.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS8"], source: "user" });
    expect(third.state.semanticFrame).toMatchObject({ intent: "rank", metricIds: ["defect.count"], dimensionIds: ["product.ecu"], limit: 5, timeScopes: [{ start: "2026-06-01", end: "2026-06-30" }] });
    expect(third.state.semanticFrame.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS8"], source: "context" });
    expect(third.state.plan.steps[0].canonicalArgs.query.filters).toContainEqual({ dimensionId: "product.os", operator: "in", values: ["OS8"], source: "context" });

    const summaries = harness.deps.threadStore.listSummaries({ actor: harness.actor, threadId: first.threadId });
    expect(summaries).toHaveLength(3);
    expect(summaries.every((item) => item.scopeHash === harness!.actor.scopeHash)).toBe(true);
    expect(summaries.map((item) => item.body.runId)).toEqual([first.runId, second.runId, third.runId]);
  });
});
