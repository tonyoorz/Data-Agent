import { describe, expect, it } from "vitest";
import {
  createAnswerEnvelope,
  createLegacyEvidence,
  renderDeterministicFallback,
  validateLegacyClaims,
  validateRenderedAnswer,
} from "../../../../server/agentRuntime/evidence.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a" };

const analyticsEvidence = createLegacyEvidence({
  evidenceId: "ev-analytics",
  actor,
  attemptId: "attempt-1",
  toolName: "query_dashboard_summary",
  toolVersion: "legacy-tool-v1",
  canonicalArgs: { filters: { years: 2026 } },
  rawResult: { toolMessage: { content: "{\"overview\":{\"ticket_count\":12},\"snapshot_version\":\"snapshot-1\"}" }, contextText: "Result: 12 defects" },
  retrievedAt: "2026-07-14T00:00:00.000Z",
});

const duplicateEvidence = createLegacyEvidence({
  evidenceId: "ev-duplicate",
  actor,
  attemptId: "attempt-2",
  toolName: "search_duplicates",
  toolVersion: "legacy-tool-v1",
  canonicalArgs: { query: "camera black screen", top_k: 3 },
  rawResult: { toolMessage: { content: "{\"result\":{\"candidates\":[{\"ticketId\":\"2687001\",\"score1to10\":9}]}}" }, contextText: "Candidate count: 1 Ticket 2687001 score 9" },
  retrievedAt: "2026-07-14T00:00:01.000Z",
});

describe("legacy-v0 evidence", () => {
  it("never upgrades provisional results to grounded and hashes content deterministically", () => {
    expect(analyticsEvidence).toMatchObject({
      schemaVersion: "1.0",
      ontologyVersion: "legacy-v0",
      evidenceType: "metric",
      quality: { groundingStatus: "legacy_equivalence", missingness: "not_applicable" },
      sourceRevision: { sourceId: "legacy:query_dashboard_summary", status: "unknown" },
      authorization: { actorScopeHash: "scope-a" },
    });
    expect(duplicateEvidence.source.system).toBe("duplicate-search");
    expect(duplicateEvidence.evidenceType).toBe("similarity");
    expect(createLegacyEvidence({ evidenceId: "ev-analytics-2", actor, attemptId: "attempt-1", toolName: "query_dashboard_summary", toolVersion: "legacy-tool-v1", canonicalArgs: { filters: { years: 2026 } }, rawResult: { toolMessage: { content: "{}" }, contextText: "different" }, retrievedAt: "2026-07-14T00:00:00.000Z" }).contentHash).not.toBe(analyticsEvidence.contentHash);
  });

  it("classifies zero, missing and unknown separately", () => {
    expect(createLegacyEvidence({ evidenceId: "zero", actor, attemptId: "a", toolName: "query_dashboard_summary", toolVersion: "v", canonicalArgs: {}, rawResult: { toolMessage: { content: "{\"overview\":{\"ticket_count\":0}}" }, contextText: "Result: 0 defects" }, retrievedAt: "2026-07-14T00:00:00.000Z" }).quality.missingness).toBe("zero");
    expect(createLegacyEvidence({ evidenceId: "missing", actor, attemptId: "a", toolName: "query_dashboard_summary", toolVersion: "v", canonicalArgs: {}, rawResult: { toolMessage: { content: "{\"overview\":{}}" }, contextText: "No count" }, retrievedAt: "2026-07-14T00:00:00.000Z" }).quality.missingness).toBe("missing");
    expect(createLegacyEvidence({ evidenceId: "unknown", actor, attemptId: "a", toolName: "query_dashboard_summary", toolVersion: "v", canonicalArgs: {}, rawResult: { toolMessage: { content: "not json" }, contextText: "ambiguous" }, retrievedAt: "2026-07-14T00:00:00.000Z" }).quality.missingness).toBe("unknown");
  });

  it("accepts supported numbers and rejects unsupported numbers or similarity-as-statistic", () => {
    const claims = [
      { claimId: "c1", type: "observed", text: "2026 年共有 12 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 12, scopeEvidenceId: "ev-analytics" }, evidenceIds: ["ev-analytics"] },
      { claimId: "c2", type: "observed", text: "共有 13 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 13, scopeEvidenceId: "ev-analytics" }, evidenceIds: ["ev-analytics"] },
      { claimId: "c3", type: "observed", text: "共有 1 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 1, scopeEvidenceId: "ev-duplicate" }, evidenceIds: ["ev-duplicate"] },
    ];
    const validation = validateLegacyClaims({ actor, claims, evidence: [analyticsEvidence, duplicateEvidence] });
    expect(validation.status).toBe("repair");
    expect(validation.acceptedClaimIds).toEqual(["c1"]);
    expect(validation.rejected.map((item) => item.claimId)).toEqual(["c2", "c3"]);
    expect(validateLegacyClaims({ actor, claims: [{ claimId: "c4", type: "observed", text: "共有 1 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 1, scopeEvidenceId: "ev-analytics" }, evidenceIds: ["ev-analytics"] }], evidence: [analyticsEvidence] }).status).toBe("rejected");
  });

  it("blocks a rendered answer that introduces a new ID and falls back deterministically", () => {
    const acceptedClaims = [{ claimId: "c1", text: "2026 年共有 12 个缺陷。", evidenceIds: ["ev-analytics"] }];
    expect(() => validateRenderedAnswer({ text: "2026 年共有 12 个缺陷，示例 ID 为 9999999。", acceptedClaims, evidence: [analyticsEvidence] })).toThrow(/UNSUPPORTED_RENDERED_TOKEN/);
    expect(renderDeterministicFallback({ acceptedClaims, limitations: ["数据来源为 Phase 1 legacy equivalence。"] })).toContain("2026 年共有 12 个缺陷");
    const answer = createAnswerEnvelope({ answerId: "answer-1", text: "2026 年共有 12 个缺陷。", acceptedClaims, citations: [], assumptions: [], limitations: [], groundingStatus: "grounded", sourceRevisionSet: {} });
    expect(answer.groundingStatus).toBe("legacy_equivalence");
    expect(answer.contentHash).toHaveLength(64);
    expect(renderDeterministicFallback({ acceptedClaims: undefined, limitations: [] })).toBe("");
    expect(createAnswerEnvelope({ answerId: "answer-2", text: "没有足够证据。", groundingStatus: "insufficient_evidence", sourceRevisionSet: {} }).acceptedClaimIds).toEqual([]);
  });

  it("rejects cross-scope evidence and causal/completeness language", () => {
    const otherScope = createLegacyEvidence({ ...analyticsEvidence, evidenceId: "ev-other", actor: { actorId: "bob", scopeHash: "scope-b" } });
    const validation = validateLegacyClaims({ actor, claims: [{ claimId: "c1", type: "observed", text: "2026 年共有 12 个缺陷，证明全部问题都由 camera 导致。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 12, scopeEvidenceId: "ev-other" }, evidenceIds: ["ev-other"] }], evidence: [otherScope] });
    expect(validation.status).toBe("rejected");
    expect(validation.rejected[0].reason).toMatch(/SCOPE_MISMATCH|UNSUPPORTED_CAUSAL_OR_COMPLETE/);
  });
});