import { describe, expect, it } from "vitest";
import {
  createAnswerEnvelope,
  createClaimsFromEvidence,
  createLegacyEvidence,
  createSemanticEvidence,
  renderDeterministicFallback,
  validateLegacyClaims,
  validateRenderedAnswer,
} from "../../../../server/agentRuntime/evidence.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";

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
  it("creates grouped comparison claims instead of collapsing groups into one total", () => {
    const ontologyRegistry = createOntologyRegistry();
    const query = {
      schemaVersion: "1.0",
      ontologyVersion: ontologyRegistry.version,
      schemaFingerprint: ontologyRegistry.fingerprint,
      intent: "compare",
      entityIds: ["quality.defect"],
      metricIds: ["defect.count"],
      dimensionIds: ["product.os"],
      filters: [{ dimensionId: "product.os", operator: "in", values: ["OS8", "OS9"], source: "user" }],
      timeScopes: [],
      comparison: { kind: "dimension_values", dimensionId: "product.os", groups: ["OS8", "OS9"] },
      sort: [],
      limit: 20,
    };
    const payload = {
      schemaVersion: "1.0",
      queryId: "attempt-compare",
      ontologyVersion: ontologyRegistry.version,
      schemaFingerprint: ontologyRegistry.fingerprint,
      sourceRevision: { sourceId: "analytics.fixture", revisionId: "snapshot-compare", status: "pinned", asOf: "2026-07-14T00:00:00.000Z", ingestionWatermark: "snapshot-compare" },
      scope: { actorScopeHash: actor.scopeHash, filters: query.filters, timeScopes: [], grain: ["one defect"] },
      data: [{ "product.os": "OS9", "defect.count": 2 }, { "product.os": "OS8", "defect.count": 1 }],
      summary: { metrics: { "defect.count": 3 }, rowCount: 3 },
      quality: { completeness: "complete", missingness: "not_applicable", truncated: false, warnings: [] },
    };
    const evidence = createSemanticEvidence({
      evidenceId: "ev-compare",
      actor,
      attemptId: "attempt-compare",
      toolName: "query_semantic_metrics",
      toolVersion: "ontology-semantic-v1",
      canonicalArgs: { query },
      rawResult: { toolMessage: { content: JSON.stringify({ ok: true, result: payload }) }, contextText: JSON.stringify(payload) },
      retrievedAt: "2026-07-14T00:00:00.000Z",
      ontologyRegistry,
    });
    const claims = createClaimsFromEvidence({ evidence: [evidence], ontologyRegistry });

    expect(claims).toHaveLength(3);
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "comparison", metricId: "defect.count", value: 2, dimensions: { "product.os": "OS9" }, evidenceIds: ["ev-compare"] }),
      expect.objectContaining({ type: "comparison", metricId: "defect.count", value: 1, dimensions: { "product.os": "OS8" }, evidenceIds: ["ev-compare"] }),
      expect.objectContaining({
        type: "derived",
        metricId: "defect.count",
        value: 1,
        derivation: expect.objectContaining({ formula: "sum(comparison)-sum(baseline)", inputClaimIds: expect.any(Array) }),
      }),
    ]));
    expect(validateLegacyClaims({ actor, claims, evidence: [evidence] }).acceptedClaimIds).toHaveLength(3);

    const tamperedClaims = claims.map((claim) => claim.type === "derived" ? { ...claim, value: 99, fact: { ...claim.fact, value: 99 } } : claim);
    expect(validateLegacyClaims({ actor, claims: tamperedClaims, evidence: [evidence] }).rejected).toContainEqual(expect.objectContaining({ reason: "DERIVATION_MISMATCH" }));

    const crossGroupTamper = claims.map((claim) => claim.dimensions?.["product.os"] === "OS9"
      ? { ...claim, value: 1, text: claim.text.replace("为 2", "为 1"), fact: { ...claim.fact, value: 1 } }
      : claim);
    expect(validateLegacyClaims({ actor, claims: crossGroupTamper, evidence: [evidence] }).rejected).toContainEqual(expect.objectContaining({ reason: "EVIDENCE_VALUE_MISMATCH" }));

    const mismatchedPayload = { ...payload, scope: { ...payload.scope, filters: [] } };
    expect(() => createSemanticEvidence({
      evidenceId: "ev-mismatch",
      actor,
      attemptId: "attempt-compare",
      toolName: "query_semantic_metrics",
      toolVersion: "ontology-semantic-v1",
      canonicalArgs: { query },
      rawResult: { toolMessage: { content: JSON.stringify({ ok: true, result: mismatchedPayload }) }, contextText: JSON.stringify(mismatchedPayload) },
      retrievedAt: "2026-07-14T00:00:00.000Z",
      ontologyRegistry,
    })).toThrow("SEMANTIC_EVIDENCE_SCOPE_MISMATCH");

    const missingDimensionPayload = { ...payload, data: [{ "defect.count": 3 }] };
    expect(() => createSemanticEvidence({
      evidenceId: "ev-dimension-mismatch",
      actor,
      attemptId: "attempt-compare",
      toolName: "query_semantic_metrics",
      toolVersion: "ontology-semantic-v1",
      canonicalArgs: { query },
      rawResult: { toolMessage: { content: JSON.stringify({ ok: true, result: missingDimensionPayload }) }, contextText: JSON.stringify(missingDimensionPayload) },
      retrievedAt: "2026-07-14T00:00:00.000Z",
      ontologyRegistry,
    })).toThrow("SEMANTIC_EVIDENCE_DIMENSION_MISMATCH");

    const wrongGroupPayload = { ...payload, data: [{ "product.os": "OS8", "defect.count": 3 }, { "product.os": "OS7", "defect.count": 1 }] };
    expect(() => createSemanticEvidence({
      evidenceId: "ev-comparison-mismatch",
      actor,
      attemptId: "attempt-compare",
      toolName: "query_semantic_metrics",
      toolVersion: "ontology-semantic-v1",
      canonicalArgs: { query },
      rawResult: { toolMessage: { content: JSON.stringify({ ok: true, result: wrongGroupPayload }) }, contextText: JSON.stringify(wrongGroupPayload) },
      retrievedAt: "2026-07-14T00:00:00.000Z",
      ontologyRegistry,
    })).toThrow("SEMANTIC_EVIDENCE_COMPARISON_MISMATCH");

    const untracedFilters = [{ dimensionId: "testing.trace_status", operator: "in", values: ["Untraced"], source: "user" }];
    const untracedEvidence = {
      ...evidence,
      evidenceId: "ev-untraced",
      evidenceType: "relationship",
      scope: { ...evidence.scope, intent: "trace", filters: { items: untracedFilters }, dimensionIds: [] },
      preview: {
        payload: {
          ...payload,
          scope: { ...payload.scope, filters: untracedFilters },
          data: [{ test_id: "TC-1" }],
          summary: { metrics: {}, rowCount: 1 },
        },
      },
    };
    const [untracedClaim] = createClaimsFromEvidence({ evidence: [untracedEvidence], ontologyRegistry });
    expect(untracedClaim).toMatchObject({ fact: { predicateId: "traceability.untraced_testcases", value: 1 } });
    expect(untracedClaim.text).toContain("1 个未关联 Requirement 的 TestCase");
    expect(validateLegacyClaims({ actor, claims: [untracedClaim], evidence: [untracedEvidence] }).status).toBe("valid");
  });

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
    expect(answer.groundingStatus).toBe("grounded");
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
