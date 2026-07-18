// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluateCases, reportToJunit } from "../../../../scripts/lib/agentRuntimeEvaluator.mjs";

function observation(terminal = "completed") {
  return {
    caseId: "case-1",
    durationMs: 5,
    events: [
      { eventId: "event-model", runId: "run-1", type: "model.completed", payload: { modelId: "fixture", purpose: "planning", finishReason: "stop", inputTokens: 1, outputTokens: 1 } },
      { eventId: "event-1", runId: "run-1", type: `run.${terminal}`, payload: {} },
    ],
    eventTypes: ["model.completed", `run.${terminal}`],
    tools: [],
    modelInvocations: 1,
    terminal,
    terminalEventCount: 1,
    duplicateEventCount: 0,
    crossActorLeakage: 0,
    unsupportedTools: [],
    earlyAnswerBytes: 0,
    runCount: 1,
    answerText: "done",
  };
}

function evalCase(expected: Record<string, unknown>) {
  return {
    case_id: "case-1",
    group: "fact",
    language: "en-US",
    expected,
    forbidden: [],
  };
}

describe("Agent Runtime evaluator", () => {
  it("derives failures from executed assertions instead of returning a fixed pass", async () => {
    const report = await evaluateCases([evalCase({ terminal: "failed" })], {
      suite: "inline",
      suiteFingerprint: "fixture",
      executeCase: async () => observation("completed"),
    });

    expect(report.passed).toBe(false);
    expect(report.failedCaseIds).toEqual(["case-1"]);
    expect(report.cases[0].assertions).toContainEqual(expect.objectContaining({ key: "terminal", pass: false }));
  });

  it("emits passing JUnit only when every observable expectation passes", async () => {
    const report = await evaluateCases([evalCase({ terminal: "completed", modelInvoked: true, terminalEventCount: 1 })], {
      suite: "inline",
      suiteFingerprint: "fixture",
      executeCase: async () => observation("completed"),
    });

    expect(report.passed).toBe(true);
    expect(report.hardGates.plannerModelCoverage).toBe(1);
    expect(reportToJunit(report)).toContain('failures="0"');
  });

  it("fails the hard gate when a run cannot prove a successful planner model call", async () => {
    const withoutModel = { ...observation("completed"), events: [{ eventId: "event-1", runId: "run-1", type: "run.completed", payload: {} }], eventTypes: ["run.completed"], modelInvocations: 0 };
    const report = await evaluateCases([evalCase({ terminal: "completed" })], {
      suite: "inline",
      suiteFingerprint: "fixture",
      executeCase: async () => withoutModel,
    });

    expect(report.hardGatesPassed).toBe(false);
    expect(report.hardGates.plannerModelCoverage).toBe(0);
  });

  it("keeps answer bodies, raw evidence, and raw run identifiers out of qualification reports", async () => {
    const sensitive = {
      ...observation("completed"),
      runId: "run-sensitive",
      threadId: "thread-sensitive",
      answerText: "TOP SECRET ANSWER 42",
      httpError: { code: "TOP SECRET PROVIDER ERROR" },
      graphState: {
        answer: { text: "TOP SECRET ANSWER 42", contentHash: "answer-hash", groundingStatus: "grounded", acceptedClaimIds: ["c1"], citations: [{ citationId: "cite-1" }], assumptions: [], limitations: [] },
        evidence: [{ preview: { raw: "TOP SECRET EVIDENCE" } }],
        claims: [{ text: "TOP SECRET CLAIM" }],
        claimValidation: { acceptedClaimIds: ["c1"] },
        modelTurns: [{ turnId: "TOP SECRET TURN", modelId: "fixture", status: "completed" }],
      },
    };
    const report = await evaluateCases([evalCase({ terminal: "completed" })], {
      suite: "inline",
      suiteFingerprint: "fixture",
      executeCase: async () => sensitive,
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("TOP SECRET");
    expect(serialized).not.toContain("run-sensitive");
    expect(serialized).not.toContain("thread-sensitive");
    expect(report.cases[0].observation.httpError).toEqual({ code: "EVAL_REQUEST_FAILED" });
    expect(report.cases[0].observation).toMatchObject({ answer: { contentHash: "answer-hash", acceptedClaimCount: 1, citationCount: 1 }, evidenceCount: 1, claimCount: 1 });
  });

  it("redacts semantic filters, tool arguments, and limitation text from failed assertions", async () => {
    const sensitive = {
      ...observation("completed"),
      graphState: {
        semanticFrame: {
          ontologyVersion: "v1",
          schemaFingerprint: "fingerprint",
          intent: "aggregate",
          entityIds: ["quality.defect"],
          metricIds: ["defect.count"],
          dimensionIds: [],
          filters: [{ dimensionId: "org.team", values: ["SECRET-TEAM"] }],
          ambiguities: [],
        },
        plan: {
          planId: "sensitive-plan-id",
          version: 1,
          status: "ready",
          steps: [{ toolName: "query_semantic_metrics", canonicalArgs: { filters: ["SECRET-PROJECT"] } }],
        },
        answer: { limitations: ["SECRET-LIMITATION"] },
      },
    };
    const report = await evaluateCases([evalCase({
      semanticFrame: { metricIds: ["wrong.metric"] },
      queryPlan: { status: "blocked" },
      limitations: true,
      answerText: "must never expose observation.answerText",
    })], {
      suite: "inline",
      suiteFingerprint: "fixture",
      executeCase: async () => sensitive,
    });
    const serialized = JSON.stringify(report);

    expect(report.passed).toBe(false);
    expect(serialized).not.toContain("SECRET-TEAM");
    expect(serialized).not.toContain("SECRET-PROJECT");
    expect(serialized).not.toContain("SECRET-LIMITATION");
    expect(serialized).not.toContain("sensitive-plan-id");
  });
});
