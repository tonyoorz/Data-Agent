// Business-rule and numeric guardrails for the answer gate (tasks 25 + 26).
//
// validateAnswerTextCitations() in answerValidator.mjs already enforces
// citation/evidence grounding. This module adds two complementary checks:
//   1. checkRuleValidations — surfaces business-rule contradictions in the answer
//      (term misuse like Top Issue/Showstopper reversal, owner=problem-finder, or
//      a KPI "达标" claim whose stated number is below the approved target).
//   2. checkNumericGuardrails — five MARS-style numeric safeguards against
//      hallucinated or implausible numbers: anchoring, outliers, fabricated
//      precision, unit inconsistency, aggregation mismatch.
// buildBusinessKnowledgeContext() renders the 12 doc-level business rules as a
// system-prompt block so answers are grounded in approved domain knowledge.
//
// All predicates are deliberately conservative — they only fire on clear
// evidence of a problem, to avoid false positives on legitimate answers. The 12
// doc-level rules are read as a registry sidecar (registry.listBusinessKnowledgeRules)
// so they stay out of the fingerprinted compiled bundle.

const NUMBER_LITERAL_PATTERN = /(?<![0-9A-Za-z_])-?\d+(?:\.\d+)?\s?%?/gu;

function extractEvidenceNumbers(evidence) {
  const numbers = new Set();
  const skipKeys = new Set(["toolCallId", "ontologyVersion", "schemaFingerprint", "sourceRevision", "tool"]);
  const visit = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (skipKeys.has(key)) continue;
        visit(value[key]);
      }
    }
  };
  visit(evidence);
  return numbers;
}

function isLikelyYearOrId(raw, sourceText, index) {
  const n = Number.parseFloat(raw);
  if (Number.isInteger(n) && n >= 1900 && n <= 2099) return true;
  const window = sourceText.slice(Math.max(0, index - 24), index);
  return /(?:id|ID|ticket|defect|run|step|TQR|phase|#)\s*:?\s*$/u.test(window);
}

function collectNumericClaims(sourceText, parsed) {
  const claims = [];
  NUMBER_LITERAL_PATTERN.lastIndex = 0;
  let match = NUMBER_LITERAL_PATTERN.exec(sourceText);
  while (match) {
    const raw = match[0];
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
      match = NUMBER_LITERAL_PATTERN.exec(sourceText);
      continue;
    }
    const mid = match.index + raw.length / 2;
    const nearCitation = (parsed?.tokens || []).some((token) => {
      const tokenMid = token.start + (token.end - token.start) / 2;
      return Math.abs(mid - tokenMid) <= 40;
    });
    claims.push({ raw, value, index: match.index, nearCitation });
    match = NUMBER_LITERAL_PATTERN.exec(sourceText);
  }
  return claims;
}

function validateNumericAnchoring(claims, evidenceNumbers, sourceText) {
  // Without any numeric evidence there is nothing to anchor against — skip rather
  // than flag every number in the answer (which would also break legitimate
  // answers whose evidence is metadata-only).
  if (evidenceNumbers.size === 0) return [];
  const violations = [];
  const pool = new Set([...evidenceNumbers]);
  for (const claim of claims) {
    if (claim.nearCitation) continue;
    if (isLikelyYearOrId(claim.raw, sourceText, claim.index)) continue;
    const direct = pool.has(claim.value);
    const asPercent = claim.raw.includes("%")
      && [...pool].some((n) => Math.round(n * 100) === Math.round(claim.value));
    if (!direct && !asPercent) {
      violations.push(`ANSWER_NUMERIC_UNANCHORED:${claim.raw.trim()}`);
    }
  }
  return violations;
}

function validateNumericOutlier(claims, evidenceNumbers) {
  const positives = [...evidenceNumbers].filter((n) => n > 0);
  if (positives.length < 1) return [];
  const max = Math.max(...positives);
  const violations = [];
  for (const claim of claims) {
    if (claim.value <= 0 || claim.raw.includes("%")) continue;
    if (claim.value > max * 10 && claim.value > max + 100) {
      violations.push(`ANSWER_NUMERIC_OUTLIER:${claim.raw.trim()}`);
    }
  }
  return violations;
}

function validateNumericPrecision(claims, evidenceNumbers) {
  if (evidenceNumbers.size === 0) return [];
  const allInteger = [...evidenceNumbers].every((n) => Number.isInteger(n));
  if (!allInteger) return [];
  const violations = [];
  for (const claim of claims) {
    if (!claim.raw.includes("%")) continue;
    if (!Number.isInteger(claim.value)) {
      violations.push(`ANSWER_NUMERIC_PRECISION_FABRICATED:${claim.raw.trim()}`);
    }
  }
  return violations;
}

function validateUnitConsistency(sourceText) {
  const text = String(sourceText || "").replace(/<[^>]+>/gu, " ");
  const violations = [];
  if (/(?:共|达|总(?:共)?|合计|累计)\s*\d+(?:\.\d+)?\s*%/u.test(text)) {
    violations.push("ANSWER_NUMERIC_UNIT_INCONSISTENT:count_quantifier_on_percent");
  }
  if (/(?:占比|比例|覆盖率|通过率|执行率)[^0-9\n]{0,12}\d+(?:\.\d+)?\s*(?:个|条|项|起)/u.test(text)) {
    violations.push("ANSWER_NUMERIC_UNIT_INCONSISTENT:ratio_label_with_count_unit");
  }
  return violations;
}

function validateNumericAggregation(sourceText) {
  const text = String(sourceText || "").replace(/<[^>]+>/gu, " ");
  const match = /(\d+(?:\.\d+)?)[^\n\d]{0,8}(?:\+|加上|以及|和)[^\n\d]{0,8}(\d+(?:\.\d+)?)[^\n\d]{0,8}(?:=|等于|共|合计)[^\n\d]{0,8}(\d+(?:\.\d+)?)/u.exec(text);
  if (!match) return [];
  const a = Number.parseFloat(match[1]);
  const b = Number.parseFloat(match[2]);
  const stated = Number.parseFloat(match[3]);
  if (Math.abs(a + b - stated) > 0.01) {
    return [`ANSWER_NUMERIC_AGGREGATION_MISMATCH:${match[0].trim()}`];
  }
  return [];
}

export function checkNumericGuardrails({ text, parsed, evidence } = {}) {
  const sourceText = String(text || "");
  const evidenceNumbers = extractEvidenceNumbers(evidence);
  const claims = collectNumericClaims(sourceText, parsed);
  return [
    ...validateNumericAnchoring(claims, evidenceNumbers, sourceText),
    ...validateNumericOutlier(claims, evidenceNumbers),
    ...validateNumericPrecision(claims, evidenceNumbers),
    ...validateUnitConsistency(sourceText),
    ...validateNumericAggregation(sourceText),
  ];
}

function extractClaimedPercentFor(text, labels, successPattern) {
  const sourceText = String(text || "");
  for (const label of labels) {
    const re = new RegExp(`${label}[^\\n.]{0,40}?(\\d+(?:\\.\\d+)?)\\s*%`, "iu");
    const m = re.exec(sourceText);
    if (m) {
      const window = sourceText.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20);
      if (successPattern.test(window)) return Number.parseFloat(m[1]);
    }
  }
  return null;
}

export function checkRuleValidations({ text, registry } = {}) {
  const sourceText = String(text || "");
  const violations = [];
  if (!registry || typeof registry.listBusinessKnowledgeRules !== "function") return violations;
  const byId = new Map(registry.listBusinessKnowledgeRules().map((rule) => [rule.id, rule]));

  // br.top_issue_vs_showstopper: Top Issue = maturity phase (can we reach RG5);
  // Showstopper = pre-go-live blocker (can we ship). Flag definition reversal.
  if (byId.has("br.top_issue_vs_showstopper")) {
    const reversed = /top\s*issue[^.\n]{0,60}(?:go\s*live|上线|可发货|customer|release)/iu.test(sourceText)
      || /showstopper[^.\n]{0,60}(?:成熟度|maturity|reifegrad|功能完整|RG[45])/iu.test(sourceText);
    if (reversed) {
      violations.push("ANSWER_BUSINESS_RULE_TERM_MISUSE:top_issue_vs_showstopper");
    }
  }

  // br.owner_field_semantics: Owner = solution responsible, NOT problem finder.
  if (byId.has("br.owner_field_semantics")) {
    if (/owner[^.\n]{0,40}(?:问题发现者|发现者|problem\s*finder|finder)/iu.test(sourceText)) {
      violations.push("ANSWER_BUSINESS_RULE_TERM_MISUSE:owner_field_semantics");
    }
  }

  // br.kpi_definitions: detect "达标/合格" claims whose number violates the target.
  const kpiRule = byId.get("br.kpi_definitions");
  if (kpiRule && Array.isArray(kpiRule.definition)) {
    for (const kpi of kpiRule.definition) {
      const target = String(kpi.target || "");
      const name = String(kpi.name || "").toLowerCase();
      const ddpMatch = target.match(/>=\s*(\d+(?:\.\d+)?)\s*%/u);
      const cwaMatch = target.match(/<=\s*(\d+(?:\.\d+)?)\s*%/u);
      if (ddpMatch && /ddp/u.test(name)) {
        const threshold = Number.parseFloat(ddpMatch[1]);
        const claimed = extractClaimedPercentFor(sourceText, ["DDP"], /(?:达标|合格|满足|通过|满足要求|pass)/iu);
        if (claimed !== null && claimed < threshold) {
          violations.push(`ANSWER_BUSINESS_RULE_KPI_BELOW_TARGET:DDP:${claimed}<${threshold}`);
        }
      }
      if (cwaMatch && /cwa/u.test(name)) {
        const threshold = Number.parseFloat(cwaMatch[1]);
        const claimed = extractClaimedPercentFor(sourceText, ["CWA", "CWA Rate"], /(?:达标|合格|可控|满足|pass)/iu);
        if (claimed !== null && claimed > threshold) {
          violations.push(`ANSWER_BUSINESS_RULE_KPI_ABOVE_TARGET:CWA:${claimed}>${threshold}`);
        }
      }
    }
  }
  return violations;
}

function formatKnowledgeDefinition(definition, lines) {
  for (const [key, value] of Object.entries(definition)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      if (value.trim()) lines.push(`- ${key}: ${value}`);
    } else if (Array.isArray(value)) {
      const compact = value
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const name = String(item.name || "").trim();
            const target = String(item.target || "").trim();
            const formula = String(item.formula || "").trim();
            if (name) return `${name}${target ? ` (target: ${target})` : ""}${formula ? ` — ${formula}` : ""}`;
            return JSON.stringify(item);
          }
          return String(item);
        })
        .filter(Boolean)
        .join("; ");
      if (compact) lines.push(`- ${key}: ${compact}`);
    } else if (typeof value === "object") {
      const compact = JSON.stringify(value);
      if (compact !== "{}") lines.push(`- ${key}: ${compact}`);
    }
  }
}

export function buildBusinessKnowledgeContext(registry) {
  if (!registry || typeof registry.listBusinessKnowledgeRules !== "function") return "";
  const rules = registry.listBusinessKnowledgeRules();
  if (!Array.isArray(rules) || rules.length === 0) return "";
  const lines = ["# Business knowledge (approved domain rules — ground every answer in these)"];
  for (const rule of rules) {
    const title = String(rule.title || rule.id || "").trim();
    if (!title) continue;
    lines.push(`## ${title}`);
    const definition = rule.definition;
    if (Array.isArray(definition)) {
      formatKnowledgeDefinition({ definition }, lines);
    } else if (definition && typeof definition === "object") {
      formatKnowledgeDefinition(definition, lines);
    } else if (typeof definition === "string" && definition.trim()) {
      lines.push(definition.trim());
    }
    if (typeof rule.semanticNotes === "string" && rule.semanticNotes.trim()) {
      lines.push(`Note: ${rule.semanticNotes.trim()}`);
    }
  }
  return lines.join("\n");
}
