// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAlternativePathRetry, isVotingDisagreementPayload } from "../../../server/mainAgentToolRecovery.mjs";

const actorScopeHash = "scope-1";

function makePlan(fingerprint, dims) {
  return {
    executionFingerprint: fingerprint,
    actorScopeHash,
    status: "valid",
    planId: `plan-${fingerprint}`,
    steps: [{
      stepId: "s1",
      operation: "semantic_metric_query",
      toolName: "query_semantic_metrics",
      metricIds: ["defect.count"],
      dimensionIds: dims,
      canonicalArgs: { query: { metrics: ["defect.count"], dimensions: dims } },
      dependsOn: [],
      riskLevel: "R0",
    }],
  };
}

const planA = makePlan("fp-direct", ["product.ecu", "quality.severity"]);
const planB = makePlan("fp-constraint-first", ["quality.severity", "product.ecu"]);

const toolCallA = {
  id: "call-1",
  type: "function",
  function: { name: "query_semantic_metrics", arguments: JSON.stringify(planA.steps[0].canonicalArgs) },
};

const candidates = [
  { kind: "direct", plan: planA },
  { kind: "constraintFirst", plan: planB },
];

describe("alternative-path retry (P0-B4)", () => {
  it("direct failed → retry swaps to constraintFirst candidate (different path, not just params)", () => {
    const retry = buildAlternativePathRetry({
      originalToolCall: toolCallA,
      failedFingerprint: planA.executionFingerprint,
      candidates,
      actorScopeHash,
    });
    expect(retry).toBeTruthy();
    expect(retry.recovery.reason).toBe("alternative_path_retry");
    expect(retry.recovery.attempts).toBe(1);
    expect(retry.recovery.maxAttempts).toBe(1); // retry cap unchanged: 1
    expect(retry.recovery.pathKind).toBe("constraintFirst");
    expect(JSON.parse(retry.toolCall.function.arguments)).toEqual(planB.steps[0].canonicalArgs);
    expect(retry.toolCall.function.name).toBe("query_semantic_metrics");
  });

  it("no alternative candidate (single path) → null, no fake retry", () => {
    const retry = buildAlternativePathRetry({
      originalToolCall: toolCallA,
      failedFingerprint: planA.executionFingerprint,
      candidates: [{ kind: "direct", plan: planA }],
      actorScopeHash,
    });
    expect(retry).toBeNull();
  });

  it("scope mismatch → null (never cross actor scope)", () => {
    const retry = buildAlternativePathRetry({
      originalToolCall: toolCallA,
      failedFingerprint: planA.executionFingerprint,
      candidates,
      actorScopeHash: "other-scope",
    });
    expect(retry).toBeNull();
  });

  it("non-semantic tool → null", () => {
    const retry = buildAlternativePathRetry({
      originalToolCall: { id: "c", type: "function", function: { name: "query_analytics", arguments: "{}" } },
      failedFingerprint: planA.executionFingerprint,
      candidates,
      actorScopeHash,
    });
    expect(retry).toBeNull();
  });

  it("voting DISAGREE is a clarification need, never a recovery trigger", () => {
    expect(isVotingDisagreementPayload({ verdict: "DISAGREE", winner: null })).toBe(true);
    expect(isVotingDisagreementPayload({ verdict: "UNANIMOUS", winner: {} })).toBe(false);
    expect(isVotingDisagreementPayload({ verdict: "MAJORITY", winner: {} })).toBe(false);
    expect(isVotingDisagreementPayload({ ok: true, rows: [] })).toBe(false);
    expect(isVotingDisagreementPayload(null)).toBe(false);
  });
});
