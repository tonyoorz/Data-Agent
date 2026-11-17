import { describe, expect, it, vi } from "vitest";
import { executeMainAgentToolCall } from "../../../server/mainAgentTools.mjs";
import { mainAgentToolDataBoundary } from "../../../server/mainAgentToolDataBoundary.mjs";

const DEFECT = {
  defect_id: "2804379",
  name: "pps constant CPU load when car is moving",
  severity: "Very High",
  software_version: "PU2707",
  assigned_ecu: "IDCEVO",
  lead_model: "G20",
  project: "SP25",
  description: "CPU load rises constantly while driving",
};

const PIPELINE_RESULT = {
  attempt: {
    testName: "[SP25][SW] Regression - pps CPU load (D2804379)",
    descriptionHtml: "<html><body>objective</body></html>",
    stepsText: "- [PreCon] vehicle ready\n- record CPU load\n- ? CPU load <= 0.17%",
    combinationCoverage: ["TC-1"],
  },
  verification: { passed: true, criteria: [{ name: "model_coverage", passed: true, evidence: "ok" }], feedback: "" },
  judge: { passed: true, criteria: [], feedback: "" },
  generationRounds: 1,
  history: [{ round: 1, heuristicPassed: true, judgePassed: true, judgeSkipped: false, failedCriteria: [] }],
  defectInfo: DEFECT,
  testModel: { dimensions: [{ name: "drive_mode", aspect: "x", classes: [{ id: "dm-1", name: "IDLE" }] }], combinations: [{ id: "TC-1", classRefs: ["dm-1"], priority: "high", rationale: "" }] },
  modelCoveragePct: 100,
  similarCases: [{ testId: "1414874", name: "pps CPU load regression", score: 0.83 }],
  contextUsed: true,
  bodiesFetched: 2,
};

function toolCallFor(args) {
  return { id: "call-1", type: "function", function: { name: "create_testcase", arguments: JSON.stringify(args) } };
}

describe("create_testcase agent tool", () => {
  it("is registered as an internal-only tool on the testcase_context toolset", () => {
    expect(mainAgentToolDataBoundary("create_testcase")).toBe("internal_only");
  });

  it("runs the pipeline via dependency injection and never claims an Octane write", async () => {
    const runTestCaseBridge = vi.fn();
    const runTestCaseGenerationPipelineFn = vi.fn(async ({ defectId, maxRounds }) => {
      expect(defectId).toBe("2804379");
      expect(maxRounds).toBe(2); // agent path bounds interactive latency
      return PIPELINE_RESULT;
    });

    const executed = await executeMainAgentToolCall(toolCallFor({ defect_id: "2804379" }), {
      runTestCaseBridge,
      runTestCaseGenerationPipelineFn,
    });

    const payload = JSON.parse(executed.toolMessage.content);
    expect(payload.ok).toBe(true);
    expect(payload.tool).toBe("create_testcase");
    expect(payload.result.verificationPassed).toBe(true);
    expect(payload.result.octaneWritten).toBe(false);
    expect(executed.contextText).toContain("# Main agent tool result");
    expect(executed.contextText).toContain("[SP25][SW] Regression - pps CPU load (D2804379)");
    expect(executed.contextText).toContain("nothing was written to Octane");
    expect(executed.contextText).toContain("/创建测试用例");
  });

  it("reports a missing defect_id without calling the bridge", async () => {
    const runTestCaseBridge = vi.fn();
    const runTestCaseGenerationPipelineFn = vi.fn();
    const executed = await executeMainAgentToolCall(toolCallFor({}), {
      runTestCaseBridge,
      runTestCaseGenerationPipelineFn,
    });
    expect(JSON.parse(executed.toolMessage.content).error).toContain("defect_id");
    expect(runTestCaseGenerationPipelineFn).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the bridge runtime is not configured", async () => {
    const executed = await executeMainAgentToolCall(toolCallFor({ defect_id: "2804379" }), {});
    expect(JSON.parse(executed.toolMessage.content).error).toContain("not configured");
    expect(executed.contextText).toContain("unavailable");
  });

  it("converts pipeline failures into a failed tool result", async () => {
    const runTestCaseBridge = vi.fn();
    const runTestCaseGenerationPipelineFn = vi.fn(async () => {
      const error = new Error("defect 999 not found");
      error.code = "TESTCASE_PREPARE_FAILED";
      throw error;
    });
    const executed = await executeMainAgentToolCall(toolCallFor({ defect_id: "999" }), {
      runTestCaseBridge,
      runTestCaseGenerationPipelineFn,
    });
    expect(JSON.parse(executed.toolMessage.content).ok).toBe(false);
    expect(executed.contextText).toContain("generation failed");
  });
});
