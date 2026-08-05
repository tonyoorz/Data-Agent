function approvedClaimEvidenceConstraint(registry) {
  try {
    return registry?.getConstraint?.("answer.claim_evidence_binding");
  } catch {
    return null;
  }
}

function evidenceByToolCallId(evidence) {
  return new Map((Array.isArray(evidence) ? evidence : [])
    .filter((item) => item?.toolCallId)
    .map((item) => [String(item.toolCallId), item]));
}

const CAUSAL_CLAIM_PATTERN = /(?:导致|造成|引发|根因\s*(?:是|为)|直接原因\s*(?:是|为)|\b(?:causes?|caused|led to|resulted in|due to|root cause\s+(?:is|was))\b)/iu;
const CAUSAL_LIMITATION_PATTERN = /(?:不能|无法|不).{0,20}(?:证明|表明).{0,20}(?:因果|导致|造成|引发|根因)|(?:不代表|并非).{0,12}(?:因果|导致|造成|根因)|\b(?:does not|doesn't|cannot|can't|not)\b.{0,24}\b(?:prove|establish|demonstrate)\b.{0,24}\b(?:causal|causation|cause)\b|\b(?:not causal|no causal evidence)\b/iu;

function hasUnsupportedCausalClaim(text) {
  const clauses = String(text || "")
    .replace(/<cite\s+[^>]*>.*?<\/cite>/giu, "")
    .split(/[。！？!?;；\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => CAUSAL_CLAIM_PATTERN.test(clause) && !CAUSAL_LIMITATION_PATTERN.test(clause));
}

function evidenceSupportsCausality(evidence) {
  return (Array.isArray(evidence) ? evidence : []).some((item) => item?.causalEvidence === true || item?.evidence?.causalEvidence === true);
}

export function validateAnswerContract({ answer, evidence = [], registry } = {}) {
  const constraint = approvedClaimEvidenceConstraint(registry);
  const coverage = Number(constraint?.parameters?.coverage || 0);
  if (!constraint || coverage <= 0) {
    return { valid: true, violations: [] };
  }

  const byId = evidenceByToolCallId(evidence);
  const citations = Array.isArray(answer?.citations) ? answer.citations : [];
  const violations = [];
  if (byId.size > 0 && citations.length === 0) {
    violations.push("ANSWER_CITATION_REQUIRED");
  }
  for (const citation of citations) {
    const toolCallId = String(citation?.toolCallId || "");
    const source = byId.get(toolCallId);
    if (!source) {
      violations.push(`ANSWER_CITATION_UNKNOWN_TOOL_CALL:${toolCallId || "missing"}`);
      continue;
    }
    if (citation.ontologyVersion && source.ontologyVersion && citation.ontologyVersion !== source.ontologyVersion) {
      violations.push(`ANSWER_CITATION_ONTOLOGY_MISMATCH:${toolCallId}`);
    }
    if (citation.schemaFingerprint && source.schemaFingerprint && citation.schemaFingerprint !== source.schemaFingerprint) {
      violations.push(`ANSWER_CITATION_SCHEMA_MISMATCH:${toolCallId}`);
    }
  }
  if (byId.size > 0 && !evidenceSupportsCausality(evidence) && hasUnsupportedCausalClaim(answer?.answer_text)) {
    violations.push("ANSWER_CAUSAL_CLAIM_UNSUPPORTED");
  }
  return { valid: violations.length === 0, violations };
}

export function extractCitationSources(text) {
  const sources = [];
  const pattern = /<cite\s+source=["']([^"']+)["'][^>]*>/gi;
  let match = pattern.exec(String(text || ""));
  while (match) {
    sources.push(match[1]);
    match = pattern.exec(String(text || ""));
  }
  return [...new Set(sources)];
}

export function validateAnswerTextCitations({ text, evidence = [], registry } = {}) {
  return validateAnswerContract({
    answer: {
      answer_text: String(text || ""),
      citations: extractCitationSources(text).map((toolCallId) => ({ toolCallId })),
    },
    evidence,
    registry,
  });
}

export function buildCitationContractContext({ evidence = [], registry } = {}) {
  const constraint = approvedClaimEvidenceConstraint(registry);
  if (!constraint || Number(constraint.parameters?.coverage || 0) <= 0) {
    return "";
  }
  const rows = [...evidenceByToolCallId(evidence).values()];
  if (!rows.length) {
    return "";
  }
  return [
    "# Citation contract",
    `Constraint: ${constraint.id}`,
    `Allowed toolCallIds: ${rows.map((item) => item.toolCallId).join(", ")}`,
    ...rows.map((item) => [
      `- ${item.toolCallId}`,
      `tool=${item.tool || "unknown_tool"}`,
      item.ontologyVersion ? `ontologyVersion=${item.ontologyVersion}` : "",
      item.schemaFingerprint ? `schemaFingerprint=${item.schemaFingerprint}` : "",
      item.sourceRevision ? `sourceRevision=${item.sourceRevision}` : "",
    ].filter(Boolean).join("; ")),
    `Format every numeric or factual data claim as <cite source="${rows[0].toolCallId}">claim</cite> using one of these toolCallIds. Do not invent citation IDs.`,
    "Do not state causal conclusions unless supplied evidence explicitly supports causality; describe associations and limitations instead.",
  ].join("\n");
}