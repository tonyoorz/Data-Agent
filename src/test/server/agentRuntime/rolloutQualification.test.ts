// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildShadowQualification, qualifyCanaryRouting, qualifyRollbackSwitch } from "../../../../scripts/lib/agentRolloutQualification.mjs";

function shadowRows(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const runId = `run-${index + 1}`;
    const createdAt = `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`;
    const semanticSignature = `${String(index + 1).padStart(64, "a")}`.slice(-64);
    const scopeSignature = `${String(index + 1).padStart(64, "b")}`.slice(-64);
    const toolSignature = `${String(index + 1).padStart(64, "c")}`.slice(-64);
    const numericSignature = `${String(index + 1).padStart(64, "d")}`.slice(-64);
    return [
      { run_id: runId, action: "runtime.shadow_dispatch", details_json: JSON.stringify({ correlationId: `correlation-${index + 1}` }), created_at: createdAt },
      { run_id: runId, action: "runtime.shadow_legacy_result", details_json: JSON.stringify({ status: "completed", durationMs: 100, answerContentHash: `legacy-${index + 1}`, semanticSignature, scopeSignature, toolSignature, numericSignature }), created_at: createdAt },
      { run_id: runId, action: "runtime.shadow_result", details_json: JSON.stringify({ status: "completed", durationMs: 110, groundingStatus: "grounded", acceptedClaimCount: 1, citationCount: 1, answerContentHash: `runtime-${index + 1}`, semanticSignature, scopeSignature, toolSignature, numericSignature }), created_at: createdAt },
    ];
  }).flat();
}

describe("Agent rollout qualification", () => {
  it("qualifies complete, grounded, cited shadow pairs without exposing row contents", () => {
    const report = buildShadowQualification(shadowRows(3), { minSamples: 3 });

    expect(report).toMatchObject({ qualification: "production-shadow", pass: true, sample: { dispatched: 3, paired: 3, runtimeCompleted: 3, legacyCompleted: 3 } });
    expect(report.metrics).toMatchObject({ pairCoverage: 1, runtimeFailureRate: 0, groundingPolicyRate: 1, citationCoverageRate: 1, latencyRegressionPct: 10, semanticMatchRate: 1, scopeMatchRate: 1, toolMatchRate: 1, numericMatchRate: 1 });
    expect(report.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("correlation-1");
    expect(JSON.stringify(report)).not.toContain("run-1");
  });

  it("fails closed for incomplete or failed shadow pairs", () => {
    const rows = shadowRows(3);
    rows.splice(rows.findIndex((row) => row.run_id === "run-3" && row.action === "runtime.shadow_result"), 1);
    const failedResult = rows.find((row) => row.run_id === "run-2" && row.action === "runtime.shadow_result");
    failedResult!.details_json = JSON.stringify({ status: "failed", durationMs: 90, groundingStatus: "pending", acceptedClaimCount: 0, citationCount: 0, code: "UPSTREAM_UNAVAILABLE" });

    const report = buildShadowQualification(rows, { minSamples: 3 });

    expect(report.pass).toBe(false);
    expect(report.gates.pairCoverage.pass).toBe(false);
    expect(report.gates.runtimeFailureRate.pass).toBe(false);
  });

  it("blocks canary when scope or numeric signatures diverge", () => {
    const rows = shadowRows(3);
    const runtimeResult = rows.find((row) => row.run_id === "run-2" && row.action === "runtime.shadow_result");
    const details = JSON.parse(runtimeResult!.details_json);
    runtimeResult!.details_json = JSON.stringify({ ...details, scopeSignature: "e".repeat(64), numericSignature: "f".repeat(64) });

    const report = buildShadowQualification(rows, { minSamples: 3 });

    expect(report.pass).toBe(false);
    expect(report.gates.scopeMatchRate.pass).toBe(false);
    expect(report.gates.numericMatchRate.pass).toBe(false);
  });

  it("proves deterministic canary distribution, allowlist override, and decision coherence", () => {
    const actorIds = Array.from({ length: 10_000 }, (_, index) => `actor-${index + 1}`);
    const report = qualifyCanaryRouting({ actorIds, percentage: 5, allowlist: ["always-v2"] });

    expect(report.pass).toBe(true);
    expect(report.gates.deterministic.actual).toBe(true);
    expect(report.gates.allowlistCoverage.actual).toBe(1);
    expect(report.actualPercentage).toBeGreaterThan(2.5);
    expect(report.actualPercentage).toBeLessThan(7.5);
  });

  it("proves the legacy and zero-percent emergency rollback switches", () => {
    const report = qualifyRollbackSwitch({ actorIds: ["alice", "bob", "carol"] });

    expect(report).toMatchObject({ qualification: "rollback-switch", pass: true });
    expect(Object.values(report.gates).every((item) => item.pass)).toBe(true);
  });
});
