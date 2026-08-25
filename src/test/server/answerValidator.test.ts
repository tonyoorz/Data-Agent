import { describe, expect, it } from "vitest";

import {
  buildCitationContractContext,
  validateAnswerContract,
  validateAnswerTextCitations,
} from "../../../server/answerValidator.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";

describe("answer validator", () => {
  const registry = createOntologyRegistry();
  const evidence = [{ toolCallId: "call-1", tool: "query_semantic_metrics", ontologyVersion: "v1", schemaFingerprint: registry.fingerprint }];
  const semanticEvidence = [{
    toolCallId: "call-1",
    tool: "query_semantic_metrics",
    ontologyVersion: "v1",
    schemaFingerprint: registry.fingerprint,
    evidence: { kind: "semantic_metric_result", metricValues: { "defect.count": 1 } },
    data: [{ defect_id: "D-1", "product.ecu": "HU", "defect.count": 1 }],
  }];

  it("requires citations to bind to real tool evidence when claim-evidence binding is approved", () => {
    expect(validateAnswerContract({ answer: { answer_text: "缺陷数是 12", citations: [] }, evidence, registry })).toEqual(
      expect.objectContaining({ valid: false, violations: ["ANSWER_CITATION_REQUIRED"] }),
    );

    expect(validateAnswerContract({ answer: { answer_text: "缺陷数是 12", citations: [{ toolCallId: "missing" }] }, evidence, registry })).toEqual(
      expect.objectContaining({ valid: false, violations: ["ANSWER_CITATION_UNKNOWN_TOOL_CALL:missing"] }),
    );

    expect(validateAnswerContract({ answer: { answer_text: "缺陷数是 12", citations: [{ toolCallId: "call-1" }] }, evidence, registry })).toEqual(
      expect.objectContaining({ valid: true, violations: [] }),
    );
  });

  it("states the exact citation markup for the available tool-call IDs", () => {
    const context = buildCitationContractContext({ evidence, registry });

    expect(context).toContain('<cite source="call-1">claim</cite>');
  });

  it("requires every claim-bearing sentence to carry its own valid citation token", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 12</cite>。测试执行数是 8。',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CLAIM_CITATION_REQUIRED:2"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 12</cite>。<cite source="call-1">测试执行数是 8</cite>。',
      evidence,
      registry,
    })).toEqual({ valid: true, violations: [] });

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 12</cite>，测试执行数是 8',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CLAIM_CITATION_REQUIRED:2"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">数据来源</cite> 缺陷数是 12',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CLAIM_CITATION_REQUIRED:1"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">Defect rate was 12.5%</cite>. Tests passed 8.',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CLAIM_CITATION_REQUIRED:2"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">Defect rate was 12.5%</cite>.',
      evidence,
      registry,
    })).toEqual({ valid: true, violations: [] });

    for (const unsupported of [
      '<cite source="call-1">缺陷总数是 12</cite>。AIDA_X 缺陷最多。',
      '<cite source="call-1">缺陷总数是 12</cite>。问题主要集中在 AIDA_X。',
      '<cite source="call-1">Defects total 12</cite>. AIDA_X has the most defects.',
    ]) {
      expect(validateAnswerTextCitations({ text: unsupported, evidence, registry })).toEqual(
        expect.objectContaining({
          valid: false,
          violations: expect.arrayContaining([expect.stringMatching(/^ANSWER_CLAIM_CITATION_REQUIRED:/)]),
        }),
      );
    }
  });

  it("rejects malformed, unknown, and duplicate citation tokens deterministically", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 12',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CITATION_TOKEN_INVALID"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="invented-call">缺陷数是 12</cite>',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CITATION_UNKNOWN_TOOL_CALL:invented-call"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 12</cite>，<cite source="call-1">缺陷数是 12</cite>',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CITATION_TOKEN_DUPLICATE:call-1"]),
    }));
  });

  it("blocks causal claims that observational analytics evidence cannot support", () => {
    expect(validateAnswerContract({
      answer: {
        answer_text: 'ECU A 导致缺陷数上升 <cite source="call-1">evidence</cite>',
        citations: [{ toolCallId: "call-1" }],
      },
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: ["ANSWER_CAUSAL_CLAIM_UNSUPPORTED"],
    }));

    expect(validateAnswerContract({
      answer: {
        answer_text: '<cite source="call-1">ECU A 与缺陷数上升相关</cite>，但现有数据不能证明因果',
        citations: [{ toolCallId: "call-1" }],
      },
      evidence,
      registry,
    })).toEqual(expect.objectContaining({ valid: true, violations: [] }));
    });

  it("accepts cited numeric and record claims supported by semantic evidence", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 1，记录为 D-1</cite>',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "pass" },
    })).toEqual({ valid: true, violations: [] });
  });

  it("rejects a cited numeric claim that does not match its evidence", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 999999</cite>',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "pass" },
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_NUMERIC_CLAIM_UNSUPPORTED:call-1"]),
    }));
  });

  it("rejects uncited numbers, unknown record identifiers, and causal wording", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">范围已确认</cite>，缺陷数是 1',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "pass" },
    }).violations).toContain("ANSWER_NUMERIC_CLAIM_UNCITED");

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">记录为 D-9</cite>',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "pass" },
    }).violations).toContain("ANSWER_RECORD_CLAIM_UNSUPPORTED:call-1");

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">由于 ECU 配置导致缺陷数是 1</cite>',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "pass" },
    }).violations).toContain("ANSWER_CAUSAL_CLAIM_UNSUPPORTED");
  });

  it("rejects semantic claims when the upstream evidence gate is blocked", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">缺陷数是 1</cite>',
      evidence: semanticEvidence,
      registry,
      evidenceGate: { status: "blocked", violations: ["SEMANTIC_SOURCE_REVISION_MISSING"] },
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_SEMANTIC_EVIDENCE_BLOCKED"]),
    }));
  });

  it("checks causal claims inside citation tokens while preserving explicit limitations", () => {
    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">ECU A 导致缺陷上升</cite>',
      evidence,
      registry,
    })).toEqual(expect.objectContaining({
      valid: false,
      violations: expect.arrayContaining(["ANSWER_CAUSAL_CLAIM_UNSUPPORTED"]),
    }));

    expect(validateAnswerTextCitations({
      text: '<cite source="call-1">ECU A 导致缺陷上升，但现有数据不能证明因果</cite>',
      evidence,
      registry,
    })).toEqual({ valid: true, violations: [] });

    for (const unsupported of [
      '<cite source="call-1">缺陷增加归因于 AIDA_X</cite>',
      '<cite source="call-1">缺陷问题源于 AIDA_X</cite>',
      '<cite source="call-1">由于 AIDA_X 变更，缺陷数上升</cite>',
      '<cite source="call-1">The defect increase stems from AIDA_X</cite>',
    ]) {
      expect(validateAnswerTextCitations({ text: unsupported, evidence, registry })).toEqual(
        expect.objectContaining({
          valid: false,
          violations: expect.arrayContaining(["ANSWER_CAUSAL_CLAIM_UNSUPPORTED"]),
        }),
      );
    }
  });
});
