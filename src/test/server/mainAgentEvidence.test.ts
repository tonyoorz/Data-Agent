// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSemanticContinuationContext,
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

  it("treats traceability as claim-bearing semantic evidence", () => {
    const gate = evaluateSemanticEvidence([{ ...validEvidence, tool: "query_traceability" }], {
      expectedActorScopeHash: "scope-a",
    });

    expect(gate.status).toBe("pass");
  });

  it("exposes only a continuation from the same actor scope", () => {
    expect(buildSemanticContinuationContext([validEvidence], { scopeHash: "scope-a" })).toContain("analysis_ref: analysis-1");
    expect(buildSemanticContinuationContext([validEvidence], { scopeHash: "scope-b" })).toBe("");
  });
});
