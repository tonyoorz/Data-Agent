// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runLoadTest } from "../../../../scripts/lib/agentRuntimeLoadRunner.mjs";

function result(index: number, error?: { code: string }) {
  return {
    index,
    query: "fixture",
    runId: `run-${index}`,
    threadId: `thread-${index}`,
    status: error ? null : "completed",
    startLatencyMs: 2 + index,
    latencyMs: 10 + index,
    eventCount: error ? 0 : 2,
    terminalEventCount: error ? 0 : 1,
    duplicateEventCount: 0,
    isolationViolations: 0,
    duplicateToolExecutions: 0,
    error,
  };
}

describe("Agent Runtime load runner", () => {
  it("runs a non-zero deterministic workload and calculates percentiles", async () => {
    const report = await runLoadTest({
      iterations: 3,
      concurrency: 2,
      executeIteration: async ({ index }) => result(index),
    });

    expect(report.iterations).toBe(3);
    expect(report.latencyMs).toMatchObject({ p50: 11, p95: 12, p99: 12 });
    expect(report.terminalEventCoverage).toBe(1);
    expect(report.qualificationGates.p95LatencyMs).toMatchObject({ pass: true, actual: 12, objective: "<= 2000" });
    expect(report.passed).toBe(true);
  });

  it("counts request failures and refuses to report success", async () => {
    const report = await runLoadTest({
      iterations: 2,
      concurrency: 1,
      executeIteration: async ({ index }) => result(index, index === 1 ? { code: "HTTP_500" } : undefined),
    });

    expect(report.errors).toBe(1);
    expect(report.errorRate).toBe(0.5);
    expect(report.passed).toBe(false);
  });

  it("keeps raw queries, run IDs, thread IDs, and error messages out of reports", async () => {
    const report = await runLoadTest({
      iterations: 1,
      concurrency: 1,
      queries: ["SECRET QUERY"],
      executeIteration: async () => ({
        ...result(0, { code: "SAFE_CODE" }),
        query: "SECRET QUERY",
        runId: "SECRET RUN",
        threadId: "SECRET THREAD",
        error: { code: "SECRET PROVIDER CODE", message: "SECRET PROVIDER MESSAGE" },
      }),
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("SECRET QUERY");
    expect(serialized).not.toContain("SECRET RUN");
    expect(serialized).not.toContain("SECRET THREAD");
    expect(serialized).not.toContain("SECRET PROVIDER MESSAGE");
    expect(report.errorSamples[0].error).toEqual({ code: "LOAD_REQUEST_FAILED" });
  });

  it("rejects a zero-iteration placeholder workload", async () => {
    await expect(runLoadTest({ iterations: 0, executeIteration: async () => result(0) })).rejects.toThrow("INVALID_ITERATIONS");
  });

  it("fails strict qualification when measured p95 exceeds the objective", async () => {
    const report = await runLoadTest({
      iterations: 2,
      concurrency: 1,
      maxP95Ms: 10,
      executeIteration: async ({ index }) => result(index),
    });

    expect(report.qualificationGates.p95LatencyMs).toMatchObject({ pass: false, actual: 11, objective: "<= 10" });
    expect(report.passed).toBe(false);
  });
});
