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

const COMPLETE_CITATION_PATTERN = /<cite\s+source=["']([^"']+)["'][^>]*>([\s\S]*?)<\/cite>/gi;
const NUMERIC_CLAIM_PATTERN = /(?<![A-Za-z0-9_-])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;
const RECORD_IDENTIFIER_PATTERN = /\b[A-Za-z][A-Za-z0-9_]*-\d+\b/g;
const CAUSAL_CLAIM_PATTERN = /(?:因为|由于|导致|造成|引发|驱动|根因\s*(?:是|为)?|直接原因\s*(?:是|为)?|\b(?:causes?|caused|led to|resulted in|due to|because of|root cause\s+(?:is|was)|driven by)\b)/iu;
const CAUSAL_LIMITATION_PATTERN = /(?:不能|无法|不).{0,20}(?:证明|表明).{0,20}(?:因果|导致|造成|引发|根因)|(?:不代表|并非).{0,12}(?:因果|导致|造成|根因)|\b(?:does not|doesn't|cannot|can't|not)\b.{0,24}\b(?:prove|establish|demonstrate)\b.{0,24}\b(?:causal|causation|cause)\b|\b(?:not causal|no causal evidence)\b/iu;

function hasUnsupportedCausalClaim(text) {
  const clauses = String(text || "")
    .replace(/<\/?cite\b[^>]*>/giu, "")
    .split(/[。！？!?;；\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => CAUSAL_CLAIM_PATTERN.test(clause) && !CAUSAL_LIMITATION_PATTERN.test(clause));
}

function evidenceSupportsCausality(evidence) {
  return (Array.isArray(evidence) ? evidence : []).some((item) => item?.causalEvidence === true || item?.evidence?.causalEvidence === true);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeNumeric(value) {
  const raw = String(value || "").trim();
  const percent = raw.endsWith("%");
  const numeric = Number(raw.replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(numeric) ? `${numeric}${percent ? "%" : ""}` : "";
}

function numericClaims(text) {
  return [...String(text || "").matchAll(NUMERIC_CLAIM_PATTERN)].map((match) => String(match[0]));
}

function recordIdentifiers(text) {
  return [...String(text || "").matchAll(RECORD_IDENTIFIER_PATTERN)].map((match) => String(match[0]));
}

function collectEvidenceScalars(value, supportedNumbers, supportedRecordIds) {
  if (typeof value === "number" && Number.isFinite(value)) {
    supportedNumbers.add(normalizeNumeric(value));
    return;
  }
  if (typeof value === "string") {
    if (/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/.test(value.trim())) {
      supportedNumbers.add(normalizeNumeric(value));
    }
    for (const recordId of recordIdentifiers(value)) {
      supportedRecordIds.add(recordId);
    }
    return;
  }
  if (Array.isArray(value)) {
    supportedNumbers.add(normalizeNumeric(value.length));
    for (const item of value) {
      collectEvidenceScalars(item, supportedNumbers, supportedRecordIds);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectEvidenceScalars(item, supportedNumbers, supportedRecordIds);
    }
  }
}

function supportedEvidenceScalars(item) {
  const supportedNumbers = new Set();
  const supportedRecordIds = new Set();
  for (const value of [item?.evidence, item?.summary, item?.data, item?.pagination]) {
    collectEvidenceScalars(value, supportedNumbers, supportedRecordIds);
  }
  return { supportedNumbers, supportedRecordIds };
}

function hasSemanticClaim(text) {
  return numericClaims(text).length > 0 || recordIdentifiers(text).length > 0 || CAUSAL_CLAIM_PATTERN.test(String(text || ""));
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

export function extractCitationClaims(text) {
  const claims = [];
  let match = COMPLETE_CITATION_PATTERN.exec(String(text || ""));
  while (match) {
    claims.push({ toolCallId: match[1], text: match[2] });
    match = COMPLETE_CITATION_PATTERN.exec(String(text || ""));
  }
  return claims;
}

export function validateAnswerTextCitations({ text, evidence = [], registry, evidenceGate } = {}) {
  const answerText = String(text || "");
  const gateStatus = String(evidenceGate?.status || "not_required");
  if (gateStatus === "blocked") {
    return hasSemanticClaim(answerText)
      ? { valid: false, violations: ["ANSWER_SEMANTIC_EVIDENCE_BLOCKED"] }
      : { valid: true, violations: [] };
  }

  const validation = validateAnswerContract({
    answer: {
      answer_text: answerText,
      citations: extractCitationSources(answerText).map((toolCallId) => ({ toolCallId })),
    },
    evidence,
    registry,
  });
  const byId = evidenceByToolCallId(evidence);
  if (!byId.size || gateStatus === "not_required") {
    return validation;
  }

  const violations = [...validation.violations];
  const claims = extractCitationClaims(answerText);
  const uncitedText = answerText.replace(COMPLETE_CITATION_PATTERN, "");
  if (numericClaims(uncitedText).length) {
    violations.push("ANSWER_NUMERIC_CLAIM_UNCITED");
  }
  if (recordIdentifiers(uncitedText).length) {
    violations.push("ANSWER_RECORD_CLAIM_UNCITED");
  }
  if (!evidenceSupportsCausality(evidence) && hasUnsupportedCausalClaim(answerText)) {
    violations.push("ANSWER_CAUSAL_CLAIM_UNSUPPORTED");
  }

  for (const claim of claims) {
    const item = byId.get(String(claim.toolCallId));
    if (!item) {
      continue;
    }
    const { supportedNumbers, supportedRecordIds } = supportedEvidenceScalars(item);
    for (const value of numericClaims(claim.text)) {
      if (!supportedNumbers.has(normalizeNumeric(value))) {
        violations.push(`ANSWER_NUMERIC_CLAIM_UNSUPPORTED:${claim.toolCallId}`);
      }
    }
    for (const recordId of recordIdentifiers(claim.text)) {
      if (!supportedRecordIds.has(recordId)) {
        violations.push(`ANSWER_RECORD_CLAIM_UNSUPPORTED:${claim.toolCallId}`);
      }
    }
  }
  const uniqueViolations = unique(violations);
  return { valid: uniqueViolations.length === 0, violations: uniqueViolations };
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