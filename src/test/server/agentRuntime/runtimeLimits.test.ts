// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, alice } from "./runtimeFixture";

function req(id: string) {
  return { schemaVersion: "1.0", messageId: id, threadVersion: 0, message: { role: "user", text: `question ${id}`, artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true, eventProtocolVersion: "1.0" };
}

describe("Runtime admission limits", () => {
  let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
  beforeEach(async () => { fixture = await createTestRuntime(); });
  afterEach(() => fixture.cleanup());

  it("rate limits starts after burst and reports Retry-After", async () => {
    for (let index = 0; index < 5; index += 1) {
      const started = await fixture.runtime.startRun({ actor: alice, request: req(`msg-${index}`) });
      await fixture.runtime.cancelRun({ actor: alice, runId: started.runId, threadVersion: started.threadVersion, reasonCode: "test_cleanup" });
    }
    await expect(fixture.runtime.startRun({ actor: alice, request: req("msg-6") })).rejects.toMatchObject({ code: "RUN_RATE_LIMITED", statusCode: 429, retryAfterSeconds: expect.any(Number) });
  });
});