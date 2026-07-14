// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "./runtimeFixture";

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
});