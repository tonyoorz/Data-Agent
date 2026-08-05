import { describe, expect, it } from "vitest";

import { buildCitationContractContext, validateAnswerContract } from "../../../server/answerValidator.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";

describe("answer validator", () => {
  const registry = createOntologyRegistry();
  const evidence = [{ toolCallId: "call-1", tool: "query_semantic_metrics", ontologyVersion: "v1", schemaFingerprint: registry.fingerprint }];

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
        answer_text: 'ECU A 与缺陷数上升相关，但现有数据不能证明因果 <cite source="call-1">evidence</cite>',
        citations: [{ toolCallId: "call-1" }],
      },
      evidence,
      registry,
    })).toEqual(expect.objectContaining({ valid: true, violations: [] }));
  });
});