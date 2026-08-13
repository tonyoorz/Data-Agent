import { checkRuleValidations, checkNumericGuardrails, buildBusinessKnowledgeContext } from "./answerGuardrails.mjs";

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

const CAUSAL_CLAIM_PATTERN = /(?:导致|造成|引发|归因于|源于|由于|促使|使得|因为.{0,40}所以|根因\s*(?:是|为)|直接原因\s*(?:是|为)|\b(?:causes?|caused|led to|resulted in|due to|attribut(?:e|ed)\s+to|stems?\s+from|because of|root cause\s+(?:is|was))\b)/iu;
const CAUSAL_LIMITATION_PATTERN = /(?:不能|无法|不).{0,20}(?:证明|表明).{0,20}(?:因果|导致|造成|引发|根因)|(?:不代表|并非).{0,12}(?:因果|导致|造成|根因)|\b(?:does not|doesn't|cannot|can't|not)\b.{0,24}\b(?:prove|establish|demonstrate)\b.{0,24}\b(?:causal|causation|cause)\b|\b(?:not causal|no causal evidence)\b/iu;
const CITATION_SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CITATION_TOKEN_PATTERN = /<cite\s+source=(["'])([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\1\s*>([\s\S]*?)<\/cite\s*>/giu;
const CITATION_LIKE_PATTERN = /<\/?cit(?:e|ation)\b/iu;
const CLAIM_CLAUSE_SEPARATOR = /[。！？!?；;，,：:、•●▪◦\n]/u;
const CAUSAL_SENTENCE_SEPARATOR = /[。！？!?；;\n]/u;
const FACTUAL_DATA_SUBJECT_PATTERN = /(?:缺陷|问题单|测试(?:用例|执行|运行)?|覆盖率|通过率|执行率|数量|总数|趋势|排名|占比|均值|中位数|项目|团队|模块|ECU|AIDA|defects?|issues?|tests?|runs?|coverage|pass\s*rate|execution\s*rate|count|total|trend|rank|average|median)/iu;
const FACTUAL_DATA_PREDICATE_PATTERN = /(?:是|为|有|共|达到|上升|下降|增长|减少|增加|最高|最低|最多|最少|主要集中|集中(?:于|在)|领先|落后|居首|垫底|排名|占比|分别|相比|同比|环比|存在|发现|通过|失败|完成|超过|高于|低于|is|are|was|were|has|have|total(?:s|ed)?|increased?|decreased?|grew|fell|ranked?|passed?|failed?|found|shows?|indicates?|equals?|exceeds?|contains?|includes?|accounts?\s+for|highest|lowest|most|least|concentrated|leading|trailing|top|bottom)/iu;

function splitPreservingDecimalPoints(text, separatorPattern) {
  const source = String(text || "");
  const clauses = [];
  let clause = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const decimalPoint = character === "." && /\d/u.test(source[index - 1] || "") && /\d/u.test(source[index + 1] || "");
    if ((!decimalPoint && character === ".") || separatorPattern.test(character)) {
      clauses.push(clause);
      clause = "";
    } else {
      clause += character;
    }
  }
  clauses.push(clause);
  return clauses;
}

function splitClaimClauses(text) {
  return splitPreservingDecimalPoints(text, CLAIM_CLAUSE_SEPARATOR);
}

function normalizeClaimText(text) {
  return String(text || "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)、])\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isClaimBearingBlock(text) {
  const normalized = normalizeClaimText(text);
  if (!normalized) return false;
  if (/\d/u.test(normalized)) return true;
  return FACTUAL_DATA_SUBJECT_PATTERN.test(normalized) && FACTUAL_DATA_PREDICATE_PATTERN.test(normalized);
}

function parseCitationTokens(text) {
  const sourceText = String(text || "");
  const tokens = [];
  const covered = new Array(sourceText.length).fill(false);
  const violations = [];
  const fingerprints = new Set();
  CITATION_TOKEN_PATTERN.lastIndex = 0;
  let match = CITATION_TOKEN_PATTERN.exec(sourceText);
  while (match) {
    const source = match[2];
    const content = String(match[3] || "").trim();
    const start = match.index;
    const end = start + match[0].length;
    for (let index = start; index < end; index += 1) covered[index] = true;
    if (!content || !CITATION_SOURCE_ID_PATTERN.test(source) || CITATION_LIKE_PATTERN.test(content)) {
      violations.push("ANSWER_CITATION_TOKEN_INVALID");
    }
    const claimBlocks = splitClaimClauses(content).filter((block) => isClaimBearingBlock(block));
    if (claimBlocks.length > 1) {
      violations.push(`ANSWER_CITATION_TOKEN_MULTIPLE_CLAIMS:${source}`);
    }
    const fingerprint = `${source}\u0000${normalizeClaimText(content)}`;
    if (fingerprints.has(fingerprint)) {
      violations.push(`ANSWER_CITATION_TOKEN_DUPLICATE:${source}`);
    }
    fingerprints.add(fingerprint);
    tokens.push({ source, content, start, end });
    match = CITATION_TOKEN_PATTERN.exec(sourceText);
  }
  const uncovered = sourceText.split("").map((character, index) => covered[index] ? " " : character).join("");
  if (CITATION_LIKE_PATTERN.test(uncovered)) {
    violations.push("ANSWER_CITATION_TOKEN_INVALID");
  }
  return { tokens, violations: [...new Set(violations)] };
}

function claimCoverageViolations(text, tokens, evidence) {
  const allowedSources = new Set((Array.isArray(evidence) ? evidence : [])
    .map((item) => String(item?.toolCallId || ""))
    .filter(Boolean));
  const sourceText = String(text || "");
  const violations = [];
  let claimIndex = 0;
  let cursor = 0;

  const inspectSegment = (segment, supported) => {
    for (const clause of splitClaimClauses(segment)) {
      if (!isClaimBearingBlock(clause)) continue;
      claimIndex += 1;
      if (!supported) violations.push(`ANSWER_CLAIM_CITATION_REQUIRED:${claimIndex}`);
    }
  };

  for (const token of tokens) {
    inspectSegment(sourceText.slice(cursor, token.start), false);
    inspectSegment(token.content, allowedSources.has(token.source));
    cursor = token.end;
  }
  inspectSegment(sourceText.slice(cursor), false);
  return violations;
}

function hasUnsupportedCausalClaim(text) {
  const clauses = splitPreservingDecimalPoints(
    String(text || "")
      .replace(/<cite\b[^>]*>/giu, "")
      .replace(/<\/cite\s*>/giu, ""),
    CAUSAL_SENTENCE_SEPARATOR,
  )
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
  return [...new Set(parseCitationTokens(text).tokens.map((token) => token.source))];
}

export function validateAnswerTextCitations({ text, evidence = [], registry } = {}) {
  const parsed = parseCitationTokens(text);
  const contract = validateAnswerContract({
    answer: {
      answer_text: String(text || ""),
      citations: [...new Set(parsed.tokens.map((token) => token.source))].map((toolCallId) => ({ toolCallId })),
    },
    evidence,
    registry,
  });
  const ruleViolations = checkRuleValidations({ text, registry });
  const numericViolations = checkNumericGuardrails({ text, parsed, evidence });
  const violations = [
    ...contract.violations,
    ...parsed.violations,
    ...claimCoverageViolations(text, parsed.tokens, evidence),
    ...ruleViolations,
    ...numericViolations,
  ];
  return { valid: violations.length === 0, violations: [...new Set(violations)] };
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
  const citationLines = [
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
    `Format every numeric or factual data claim as <cite source="${rows[0].toolCallId}">claim</cite> using one of these toolCallIds. Use a separate citation token for each claim-bearing sentence or block; do not invent, duplicate, or fake citation tokens.`,
    "Do not state causal conclusions unless supplied evidence explicitly supports causality; describe associations and limitations instead.",
  ];
  const citationBlock = citationLines.join("\n");
  const knowledgeBlock = buildBusinessKnowledgeContext(registry);
  return knowledgeBlock ? `${knowledgeBlock}\n\n${citationBlock}` : citationBlock;
}
