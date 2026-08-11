// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSemanticContinuationContext,
  evaluateClaimEvidence,
  evaluateSemanticEvidence,
  formatSemanticEvidenceGate,
} from "../../../server/mainAgentEvidence.mjs";

const validEvidence = {
  tool: "query_semantic_metrics",
  toolCallId: "semantic-1",
  ok: true,
  ontologyVersion: "v1",
  schemaFingerprint: "f".repeat(64),
  analysisRef: "analysis-1",
  sourceRevision: { revisionId: "snap-1", status: "pinned" },
  scope: { actorScopeHash: "scope-a", filters: [] },
  quality: { completeness: "complete", warnings: [] },
  evidence: { kind: "semantic_metric_result", analysisRef: "analysis-1", sourceRevisionId: "snap-1" },
};

const validTraceEvidence = {
  ...validEvidence,
  tool: "query_traceability",
  analysisRef: "analysis-trace-1",
  evidence: {
    kind: "semantic_lineage_result",
    analysisRef: "analysis-trace-1",
    sourceRevisionId: "snap-1",
    rowCount: 1,
    relationshipIds: ["testing.test_run.executes.test_case"],
  },
};

describe("main agent semantic evidence", () => {
  it("passes only complete machine-checkable semantic evidence", () => {
    const gate = evaluateSemanticEvidence([validEvidence]);

    expect(gate).toEqual({
      status: "pass",
      violations: [],
      analysisRefs: ["analysis-1"],
      sourceRevisionIds: ["snap-1"],
      warnings: [],
    });
    expect(formatSemanticEvidenceGate(gate)).toContain("Status: PASS");
  });

  it("blocks semantic claims when provenance or backend evidence is absent", () => {
    const gate = evaluateSemanticEvidence([{
      ...validEvidence,
      analysisRef: undefined,
      evidence: undefined,
      sourceRevision: undefined,
    }]);

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toEqual(expect.arrayContaining([
      "SEMANTIC_ANALYSIS_REF_MISSING",
      "SEMANTIC_SOURCE_REVISION_MISSING",
      "SEMANTIC_BACKEND_EVIDENCE_MISSING",
    ]));
    expect(formatSemanticEvidenceGate(gate)).toContain("Do not state numerical or record-level claims");
  });

  it("blocks failed tool results and revision drift behind one analysis ref", () => {
    const gate = evaluateSemanticEvidence([
      { ...validEvidence, ok: false },
      {
        ...validEvidence,
        tool: "query_semantic_records",
        sourceRevision: { revisionId: "snap-2", status: "pinned" },
        evidence: { kind: "semantic_record_set", analysisRef: "analysis-1", sourceRevisionId: "snap-2" },
      },
    ]);

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toEqual(expect.arrayContaining([
      "SEMANTIC_TOOL_RESULT_FAILED",
      "SEMANTIC_ANALYSIS_REVISION_INCONSISTENT",
    ]));
  });

  it("blocks evidence from a different actor scope", () => {
    const gate = evaluateSemanticEvidence([validEvidence], { expectedActorScopeHash: "scope-b" });

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toContain("SEMANTIC_SCOPE_EVIDENCE_MISMATCH");
  });

  it("fails closed when the expected actor scope or source revision binding is missing", () => {
    const gate = evaluateSemanticEvidence([validEvidence], { requireReleaseBinding: true });

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toEqual(expect.arrayContaining([
      "SEMANTIC_EXPECTED_SCOPE_MISSING",
      "SEMANTIC_EXPECTED_SOURCE_REVISION_MISSING",
    ]));
  });

  it("blocks evidence outside the expected source revision set", () => {
    const gate = evaluateSemanticEvidence([validEvidence], {
      expectedActorScopeHash: "scope-a",
      expectedSourceRevisionIds: ["snap-2"],
      requireReleaseBinding: true,
    });

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toContain("SEMANTIC_SOURCE_REVISION_EXPECTATION_MISMATCH");
  });

  it("treats traceability as claim-bearing semantic evidence", () => {
    const gate = evaluateSemanticEvidence([validTraceEvidence], {
      expectedActorScopeHash: "scope-a",
    });

    expect(gate.status).toBe("pass");
  });

  it("rejects a metric evidence kind presented by the trace tool", () => {
    const gate = evaluateSemanticEvidence([{
      ...validTraceEvidence,
      evidence: { ...validTraceEvidence.evidence, kind: "semantic_metric_result" },
    }]);

    expect(gate.status).toBe("blocked");
    expect(gate.violations).toContain("SEMANTIC_BACKEND_EVIDENCE_KIND_INVALID");
  });

  it("fails closed for legacy or unknown fact-producing tools without a release contract", () => {
    const legacy = evaluateClaimEvidence([{
      tool: "query_defect_aggregate",
      toolCallId: "legacy-1",
      ok: true,
      summary: { defectCount: 12 },
    }]);
    const unknown = evaluateClaimEvidence([{
      tool: "future_fact_tool",
      toolCallId: "future-1",
      ok: true,
      summary: { value: 99 },
    }]);

    expect(legacy).toMatchObject({
      status: "blocked",
      violations: ["CLAIM_TOOL_RELEASE_CONTRACT_MISSING:query_defect_aggregate"],
    });
    expect(unknown).toMatchObject({
      status: "blocked",
      violations: ["CLAIM_TOOL_RELEASE_CONTRACT_MISSING:future_fact_tool"],
    });
  });

  it("keeps a pure clarification outside the factual release gate", () => {
    expect(evaluateClaimEvidence([{
      tool: "ask_clarification",
      toolCallId: "clarify-1",
      ok: true,
    }])).toEqual({
      status: "not_required",
      violations: [],
      analysisRefs: [],
      sourceRevisionIds: [],
      warnings: [],
    });
  });

  it("keeps metadata helpers outside the data-claim gate while a semantic result passes", () => {
    const metadataTools = ["get_data_catalog", "get_ontology_catalog", "search_octane_fields", "resolve_business_terms"];
    const metadataEvidence = metadataTools.map((tool, index) => ({
      tool,
      toolCallId: `metadata-${index + 1}`,
      ok: true,
    }));
    const executedToolCalls = [
      ...metadataTools.map((name, index) => ({ id: `metadata-${index + 1}`, function: { name } })),
      { id: "semantic-1", function: { name: "query_semantic_metrics" } },
    ];

    expect(evaluateClaimEvidence([...metadataEvidence, validEvidence], { executedToolCalls })).toMatchObject({
      status: "pass",
      violations: [],
    });
  });

  it("requires every evidence envelope to bind to an executed tool call", () => {
    expect(evaluateClaimEvidence([validEvidence], { executedToolCalls: [] })).toMatchObject({
      status: "blocked",
      violations: ["CLAIM_EVIDENCE_TOOL_CALL_UNKNOWN:semantic-1/query_semantic_metrics"],
    });
  });

  it("requires one distinct evidence envelope for each executed factual tool call", () => {
    const duplicateCalls = [
      { id: "semantic-1", function: { name: "query_semantic_metrics" } },
      { id: "semantic-1", function: { name: "query_semantic_metrics" } },
    ];

    expect(evaluateClaimEvidence([validEvidence], { executedToolCalls: duplicateCalls })).toMatchObject({
      status: "blocked",
      violations: expect.arrayContaining([
        "CLAIM_TOOL_CALL_ID_DUPLICATE:semantic-1",
        "CLAIM_TOOL_EVIDENCE_MISSING:semantic-1/query_semantic_metrics",
      ]),
    });
  });

  it("requires non-empty globally unique IDs before matching tool and evidence pairs", () => {
    const duplicateCallId = evaluateClaimEvidence([validEvidence], {
      executedToolCalls: [
        { id: "semantic-1", function: { name: "query_semantic_metrics" } },
        { id: "semantic-1", function: { name: "query_traceability" } },
      ],
    });
    expect(duplicateCallId).toMatchObject({ status: "blocked" });
    expect(duplicateCallId.violations).toContain("CLAIM_TOOL_CALL_ID_DUPLICATE:semantic-1");

    const duplicateEvidenceId = evaluateClaimEvidence([
      validEvidence,
      { ...validEvidence, tool: "query_traceability" },
    ]);
    expect(duplicateEvidenceId.violations).toContain("CLAIM_EVIDENCE_TOOL_CALL_ID_DUPLICATE:semantic-1");

    const missingIds = evaluateClaimEvidence([{ ...validEvidence, toolCallId: "" }], {
      executedToolCalls: [{ id: "", function: { name: "query_semantic_metrics" } }],
    });
    expect(missingIds.violations).toEqual(expect.arrayContaining([
      "CLAIM_TOOL_CALL_ID_MISSING:query_semantic_metrics",
      "CLAIM_EVIDENCE_TOOL_CALL_ID_MISSING:query_semantic_metrics",
    ]));

    const mismatchedTool = evaluateClaimEvidence([validEvidence], {
      executedToolCalls: [{ id: "semantic-1", function: { name: "query_traceability" } }],
    });
    expect(mismatchedTool.violations).toEqual(expect.arrayContaining([
      "CLAIM_TOOL_EVIDENCE_MISSING:semantic-1/query_traceability",
      "CLAIM_EVIDENCE_TOOL_CALL_UNKNOWN:semantic-1/query_semantic_metrics",
    ]));
  });

  it("exposes only a continuation from the same actor scope", () => {
    expect(buildSemanticContinuationContext([validEvidence], { scopeHash: "scope-a" })).toContain("analysis_ref: analysis-1");
    expect(buildSemanticContinuationContext([validEvidence], { scopeHash: "scope-b" })).toBe("");
  });

  it("does not expose trace analysis refs as records continuation context", () => {
    expect(buildSemanticContinuationContext([validTraceEvidence], { scopeHash: "scope-a" })).toBe("");
  });
});
