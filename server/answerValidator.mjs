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
  ].join("\n");
}