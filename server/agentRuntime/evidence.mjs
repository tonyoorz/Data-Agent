import { createHash } from "node:crypto";

const TOKEN_RE = /\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z][A-Za-z0-9_-]*-\d+\b|\b\d+(?:\.\d+)?%?\b/g;
const CAUSAL_RE = /导致|证明|全部|complete|caused by|all\b/i;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value)) ?? "null").digest("hex");
}

function parseContent(rawResult) {
  try { return JSON.parse(String(rawResult?.toolMessage?.content || "null")); }
  catch { return { unparsed: String(rawResult?.toolMessage?.content || "") }; }
}

function tokens(text) {
  return [...String(text || "").matchAll(TOKEN_RE)].map((match) => match[0]);
}

function previewText(evidence) {
  return JSON.stringify(evidence.preview || {}) + " " + String(evidence.preview?.contextText || "") + " " + JSON.stringify(evidence.source?.canonicalArgs || {});
}

function supportedTokens(evidenceItems, extraText = "") {
  return new Set(tokens(`${evidenceItems.map(previewText).join(" ")} ${extraText}`));
}

function sameSemanticValue(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Number(actual) === Number(expected);
}

function semanticClaimValueMatches(claim, evidenceItems) {
  const semanticEvidence = evidenceItems.filter((item) => item.quality?.groundingStatus === "grounded" && item.ontologyVersion !== "legacy-v0");
  if (!semanticEvidence.length) return true;
  if (!sameSemanticValue(claim.value ?? claim.fact?.value, claim.fact?.value)) return false;

  if (claim.metricId) {
    const dimensions = Object.entries(claim.dimensions || {});
    return semanticEvidence.some((item) => {
      const payload = item.preview?.payload || {};
      if (!dimensions.length) return sameSemanticValue(payload.summary?.metrics?.[claim.metricId], claim.fact?.value);
      return (Array.isArray(payload.data) ? payload.data : []).some((row) => dimensions.every(([dimensionId, value]) => String(row?.[dimensionId]) === String(value))
        && sameSemanticValue(row?.[claim.metricId], claim.fact?.value));
    });
  }

  if (["traceability.rows", "traceability.untraced_testcases"].includes(claim.fact?.predicateId)) {
    return semanticEvidence.some((item) => sameSemanticValue(item.preview?.payload?.summary?.rowCount, claim.fact?.value));
  }
  return true;
}

function missingness(payload) {
  const value = payload?.overview?.ticket_count ?? payload?.ticket_count ?? payload?.count;
  if (value === 0) return "zero";
  if (value == null && payload && typeof payload === "object" && !("unparsed" in payload)) return "missing";
  if (payload?.unparsed != null) return "unknown";
  return "not_applicable";
}

function semanticPayload(rawResult) {
  const parsed = parseContent(rawResult);
  return parsed?.result && typeof parsed.result === "object" ? parsed.result : parsed;
}

function evidenceTypeForTool(toolName) {
  if (toolName === "query_traceability") return "relationship";
  if (toolName === "query_semantic_records") return "records";
  return "metric";
}

export function createSemanticEvidence(input) {
  const payload = semanticPayload(input.rawResult);
  const query = input.canonicalArgs?.query || {};
  if (!payload || typeof payload !== "object" || payload.schemaVersion !== "1.0") throw Object.assign(new Error("SEMANTIC_EVIDENCE_PAYLOAD_INVALID"), { code: "SEMANTIC_EVIDENCE_PAYLOAD_INVALID" });
  if (String(payload.queryId || "") !== String(input.attemptId || "")) throw Object.assign(new Error("SEMANTIC_EVIDENCE_QUERY_MISMATCH"), { code: "SEMANTIC_EVIDENCE_QUERY_MISMATCH" });
  if (payload.ontologyVersion !== query.ontologyVersion || payload.schemaFingerprint !== query.schemaFingerprint) {
    throw Object.assign(new Error("SEMANTIC_EVIDENCE_ONTOLOGY_MISMATCH"), { code: "SEMANTIC_EVIDENCE_ONTOLOGY_MISMATCH" });
  }
  if (payload.scope?.actorScopeHash !== input.actor.scopeHash) throw Object.assign(new Error("SEMANTIC_EVIDENCE_SCOPE_MISMATCH"), { code: "SEMANTIC_EVIDENCE_SCOPE_MISMATCH" });
  if (hash(payload.scope?.filters || []) !== hash(query.filters || []) || hash(payload.scope?.timeScopes || []) !== hash(query.timeScopes || [])) {
    throw Object.assign(new Error("SEMANTIC_EVIDENCE_SCOPE_MISMATCH"), { code: "SEMANTIC_EVIDENCE_SCOPE_MISMATCH" });
  }
  const expectedMetricIds = [...(query.metricIds || [])].sort();
  const returnedMetricIds = Object.keys(payload.summary?.metrics || {}).sort();
  if (hash(returnedMetricIds) !== hash(expectedMetricIds)) throw Object.assign(new Error("SEMANTIC_EVIDENCE_METRIC_MISMATCH"), { code: "SEMANTIC_EVIDENCE_METRIC_MISMATCH" });
  const returnedRows = Array.isArray(payload.data) ? payload.data : [];
  const requestedDimensionIds = Array.isArray(query.dimensionIds) ? query.dimensionIds : [];
  if (
    requestedDimensionIds.length
    && ((Number(payload.summary?.rowCount) > 0 && returnedRows.length === 0)
      || returnedRows.some((row) => !row || requestedDimensionIds.some((dimensionId) => !Object.hasOwn(row, dimensionId))))
  ) {
    throw Object.assign(new Error("SEMANTIC_EVIDENCE_DIMENSION_MISMATCH"), { code: "SEMANTIC_EVIDENCE_DIMENSION_MISMATCH" });
  }
  if (query.comparison && returnedRows.length) {
    const returnedGroups = new Set(returnedRows.map((row) => String(row?.[query.comparison.dimensionId] ?? "")));
    const expectedGroups = new Set((query.comparison.groups || []).map(String));
    if ([...expectedGroups].some((group) => !returnedGroups.has(group)) || [...returnedGroups].some((group) => !expectedGroups.has(group))) {
      throw Object.assign(new Error("SEMANTIC_EVIDENCE_COMPARISON_MISMATCH"), { code: "SEMANTIC_EVIDENCE_COMPARISON_MISMATCH" });
    }
  }
  const revision = payload.sourceRevision || {};
  if (!revision.sourceId || !revision.revisionId || !revision.status || !revision.asOf) throw Object.assign(new Error("SEMANTIC_EVIDENCE_REVISION_REQUIRED"), { code: "SEMANTIC_EVIDENCE_REVISION_REQUIRED" });
  const contextText = String(input.rawResult?.contextText || "");
  const metricIds = Array.isArray(query.metricIds) ? query.metricIds : [];
  const metricDefinition = metricIds.length === 1 && input.ontologyRegistry
    ? input.ontologyRegistry.getMetric(metricIds[0])
    : null;
  const returnedCount = returnedRows.length;
  const totalCount = Number.isInteger(payload.summary?.rowCount) ? payload.summary.rowCount : returnedCount;
  return {
    schemaVersion: "1.0",
    evidenceId: input.evidenceId,
    ontologyVersion: payload.ontologyVersion,
    schemaFingerprint: payload.schemaFingerprint,
    evidenceType: evidenceTypeForTool(input.toolName),
    source: {
      system: "analytics",
      endpoint: "/api/semantic/query",
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      attemptId: input.attemptId,
      queryFingerprint: hash(query),
      canonicalArgsHash: hash(input.canonicalArgs || {}),
    },
    sourceRevision: revision,
    scope: {
      objectType: Array.isArray(query.entityIds) ? query.entityIds.join(",") || "semantic-query" : "semantic-query",
      intent: query.intent,
      dimensionIds: Array.isArray(query.dimensionIds) ? [...query.dimensionIds] : [],
      filters: { items: payload.scope?.filters || [] },
      timeScopes: payload.scope?.timeScopes || [],
      comparison: query.comparison || null,
      grain: Array.isArray(payload.scope?.grain) ? payload.scope.grain.join("; ") : String(payload.scope?.grain || ""),
    },
    ...(metricDefinition ? {
      metric: {
        metricId: metricDefinition.id,
        definitionVersion: metricDefinition.definitionVersion,
        unit: metricDefinition.unit,
        missingDataPolicy: metricDefinition.missingDataPolicy,
      },
    } : {}),
    contentHash: hash({ payload, query, toolVersion: input.toolVersion }),
    preview: { payload, contextText: contextText.slice(0, 20000) },
    quality: {
      groundingStatus: "grounded",
      completeness: ["complete", "partial"].includes(payload.quality?.completeness) ? payload.quality.completeness : "unknown",
      truncation: { truncated: Boolean(payload.quality?.truncated), returnedCount, totalCount },
      missingness: ["zero", "missing", "unknown", "not_applicable"].includes(payload.quality?.missingness) ? payload.quality.missingness : "unknown",
      warnings: Array.isArray(payload.quality?.warnings) ? payload.quality.warnings.map(String) : [],
    },
    authorization: { actorScopeHash: input.actor.scopeHash, redactionStatus: ["not_required", "applied", "denied"].includes(payload.quality?.redactionStatus) ? payload.quality.redactionStatus : "not_required" },
    retrievedAt: input.retrievedAt,
  };
}

function claimScopeText(evidence, dimensions = {}) {
  const payload = evidence.preview?.payload || {};
  const comparison = evidence.scope?.comparison;
  const comparisonGroup = comparison?.kind === "time_periods" ? dimensions[comparison.dimensionId] : null;
  const primary = comparisonGroup
    ? payload.scope?.timeScopes?.find?.((item) => `${item.start}/${item.end}` === String(comparisonGroup))
    : payload.scope?.timeScopes?.find?.((item) => item.role === "primary") || payload.scope?.timeScopes?.[0];
  const policyValues = (payload.scope?.filters || [])
    .filter((item) => item.source === "policy")
    .flatMap((item) => item.values || [])
    .map(String);
  const parts = [];
  if (primary?.start && primary?.end) parts.push(`${primary.start} 至 ${primary.end}`);
  if (policyValues.length) parts.push(`${[...new Set(policyValues)].join("/")} 范围`);
  return parts.length ? `在${parts.join("、")}内，` : "";
}

export function createClaimsFromEvidence({ evidence, ontologyRegistry }) {
  const claims = [];
  for (const item of evidence || []) {
    const payload = item.preview?.payload || {};
    if (item.quality?.groundingStatus === "grounded") {
      for (const [metricId, value] of Object.entries(payload.summary?.metrics || {})) {
        if (!Number.isFinite(value)) continue;
        const metric = ontologyRegistry?.getMetric(metricId);
        const label = metric?.labels?.["zh-CN"] || metricId;
        const groupedRows = Array.isArray(payload.data) && item.scope?.dimensionIds?.length
          ? payload.data.filter((row) => Number.isFinite(row?.[metricId]))
          : [];
        if (groupedRows.length) {
          const groupedClaims = [];
          for (const [index, row] of groupedRows.entries()) {
            const dimensions = Object.fromEntries(item.scope.dimensionIds.map((dimensionId) => [dimensionId, row[dimensionId]]));
            const dimensionText = Object.entries(dimensions).map(([dimensionId, dimensionValue]) => `${dimensionId}=${String(dimensionValue)}`).join("、");
            groupedClaims.push({
              claimId: `claim-${item.evidenceId}-${metricId.replace(/[^a-z0-9]+/gi, "-")}-group-${index + 1}`,
              type: item.scope.intent === "compare" ? "comparison" : "observed",
              metricId,
              metricDefinitionVersion: metric?.definitionVersion || "unknown",
              value: row[metricId],
              unit: metric?.unit || "count",
              dimensions,
              timeScopes: item.scope.timeScopes || [],
              derivation: null,
              text: `${claimScopeText(item, dimensions)}${dimensionText}，${label}为 ${row[metricId]}${metric?.unit === "percent" ? "%" : ""}。`,
              fact: { subjectRef: dimensionText, predicateId: metricId, value: row[metricId], scopeEvidenceId: item.evidenceId },
              evidenceIds: [item.evidenceId],
            });
          }
          claims.push(...groupedClaims);
          const comparison = item.scope?.comparison;
          if (item.scope.intent === "compare" && comparison?.groups?.length === 2) {
            const [baselineGroup, comparisonGroup] = comparison.groups.map(String);
            const baselineClaims = groupedClaims.filter((claim) => String(claim.dimensions?.[comparison.dimensionId]) === baselineGroup);
            const comparisonClaims = groupedClaims.filter((claim) => String(claim.dimensions?.[comparison.dimensionId]) === comparisonGroup);
            if (baselineClaims.length && comparisonClaims.length) {
              const baselineValue = baselineClaims.reduce((sum, claim) => sum + Number(claim.value), 0);
              const comparisonValue = comparisonClaims.reduce((sum, claim) => sum + Number(claim.value), 0);
              const delta = comparisonValue - baselineValue;
              const direction = delta > 0 ? `增加 ${delta}` : delta < 0 ? `减少 ${Math.abs(delta)}` : "持平（差值 0）";
              const inputClaimIds = [...baselineClaims, ...comparisonClaims].map((claim) => claim.claimId);
              claims.push({
                claimId: `claim-${item.evidenceId}-${metricId.replace(/[^a-z0-9]+/gi, "-")}-delta`,
                type: "derived",
                metricId,
                metricDefinitionVersion: metric?.definitionVersion || "unknown",
                value: delta,
                unit: metric?.unit || "count",
                dimensions: { [comparison.dimensionId]: `${comparisonGroup} vs ${baselineGroup}` },
                timeScopes: item.scope.timeScopes || [],
                derivation: {
                  formula: "sum(comparison)-sum(baseline)",
                  inputClaimIds,
                  baselineClaimIds: baselineClaims.map((claim) => claim.claimId),
                  comparisonClaimIds: comparisonClaims.map((claim) => claim.claimId),
                },
                text: `${comparisonGroup} 相比 ${baselineGroup}，${label}${direction}${metric?.unit === "percent" ? " 个百分点" : ""}。`,
                fact: { subjectRef: `${comparisonGroup} vs ${baselineGroup}`, predicateId: `${metricId}.delta`, value: delta, scopeEvidenceId: item.evidenceId },
                evidenceIds: [item.evidenceId],
              });
            }
          }
          continue;
        }
        claims.push({
          claimId: `claim-${item.evidenceId}-${metricId.replace(/[^a-z0-9]+/gi, "-")}`,
          type: "observed",
          metricId,
          metricDefinitionVersion: metric?.definitionVersion || "unknown",
          value,
          unit: metric?.unit || "count",
          dimensions: {},
          timeScopes: item.scope.timeScopes || [],
          derivation: null,
          text: `${claimScopeText(item)}${label}为 ${value}${metric?.unit === "percent" ? "%" : ""}。`,
          fact: { subjectRef: (payload.scope?.filters?.[0]?.values || ["authorized-scope"])[0], predicateId: metricId, value, scopeEvidenceId: item.evidenceId },
          evidenceIds: [item.evidenceId],
        });
      }
      if (item.evidenceType === "relationship" && Number.isFinite(payload.summary?.rowCount)) {
        const untracedTestcases = (payload.scope?.filters || []).some((filter) => filter.dimensionId === "testing.trace_status" && filter.values?.includes("Untraced"));
        claims.push({
          claimId: `claim-${item.evidenceId}-relationships`,
          type: "observed",
          text: untracedTestcases
            ? `${claimScopeText(item)}返回 ${payload.summary.rowCount} 个未关联 Requirement 的 TestCase。`
            : `${claimScopeText(item)}返回 ${payload.summary.rowCount} 条可追溯链路。`,
          fact: { subjectRef: "authorized-scope", predicateId: untracedTestcases ? "traceability.untraced_testcases" : "traceability.rows", value: payload.summary.rowCount, scopeEvidenceId: item.evidenceId },
          evidenceIds: [item.evidenceId],
        });
      }
    } else if (item.evidenceType === "similarity") {
      const candidates = payload?.result?.candidates || payload?.candidates;
      if (Array.isArray(candidates)) {
        claims.push({ claimId: `claim-${item.evidenceId}-similarity`, type: "observed", text: `找到 ${candidates.length} 个相似候选。`, fact: { subjectRef: "query", predicateId: "similarity.candidates", value: candidates.length, scopeEvidenceId: item.evidenceId }, evidenceIds: [item.evidenceId] });
      }
    }
  }
  if (!claims.length && evidence?.[0]) claims.push({ claimId: `claim-${evidence[0].evidenceId}-limitation`, type: "limitation", text: "当前证据不足以形成确定结论。", evidenceIds: [evidence[0].evidenceId] });
  return claims;
}

export function createLegacyEvidence(input) {
  const payload = parseContent(input.rawResult);
  const duplicate = input.toolName === "search_duplicates";
  const contextText = String(input.rawResult?.contextText || "");
  const candidates = duplicate ? (payload?.result?.candidates || payload?.candidates) : null;
  const preview = { payload, contextText: contextText.slice(0, 20000), ...(Array.isArray(candidates) ? { candidateCount: candidates.length } : {}) };
  const truncated = contextText.length > 20000;
  return {
    schemaVersion: "1.0",
    evidenceId: input.evidenceId,
    ontologyVersion: "legacy-v0",
    schemaFingerprint: "legacy-v0",
    evidenceType: duplicate ? "similarity" : "metric",
    source: {
      system: duplicate ? "duplicate-search" : "analytics",
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      attemptId: input.attemptId,
      queryFingerprint: hash({ toolName: input.toolName, canonicalArgs: input.canonicalArgs }),
      canonicalArgsHash: hash(input.canonicalArgs),
      canonicalArgs: input.canonicalArgs || {},
    },
    sourceRevision: { sourceId: `legacy:${input.toolName}`, status: "unknown" },
    scope: { objectType: duplicate ? "defect-similarity" : "defect", timeScopes: [] },
    contentHash: hash({ payload, contextText, canonicalArgs: input.canonicalArgs, toolVersion: input.toolVersion }),
    preview,
    quality: {
      groundingStatus: "legacy_equivalence",
      completeness: truncated ? "partial" : "unknown",
      truncation: { truncated },
      missingness: missingness(payload),
      warnings: [],
    },
    authorization: { actorScopeHash: input.actor.scopeHash, redactionStatus: "not_required" },
    retrievedAt: input.retrievedAt,
  };
}

export function validateLegacyClaims({ actor, claims, evidence }) {
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  const claimsById = new Map(claims.map((item) => [item.claimId, item]));
  const acceptedClaimIds = [];
  const rejected = [];
  const warnings = [];

  for (const claim of claims) {
    const claimEvidence = (claim.evidenceIds || []).map((id) => byId.get(id)).filter(Boolean);
    let reason = "";
    if (claimEvidence.length === 0 || !claim.fact?.scopeEvidenceId) reason = "EVIDENCE_REQUIRED";
    else if (claimEvidence.some((item) => item.authorization.actorScopeHash !== actor.scopeHash)) reason = "SCOPE_MISMATCH";
    else if (CAUSAL_RE.test(claim.text || "")) reason = "UNSUPPORTED_CAUSAL_OR_COMPLETE";
    else if (/count|数量|共有|多少|defect\.count/.test(`${claim.fact?.predicateId || ""} ${claim.text || ""}`) && claimEvidence.every((item) => item.evidenceType === "similarity")) reason = "SIMILARITY_IS_NOT_STATISTIC";
    else if (claim.derivation?.formula === "sum(comparison)-sum(baseline)") {
      const baselineClaims = (claim.derivation.baselineClaimIds || []).map((id) => claimsById.get(id));
      const comparisonClaims = (claim.derivation.comparisonClaimIds || []).map((id) => claimsById.get(id));
      const declaredInputs = claim.derivation.inputClaimIds || [];
      const actualInputs = [...baselineClaims, ...comparisonClaims].filter(Boolean).map((item) => item.claimId);
      const expected = comparisonClaims.reduce((sum, item) => sum + Number(item?.value || 0), 0)
        - baselineClaims.reduce((sum, item) => sum + Number(item?.value || 0), 0);
      if (!baselineClaims.length || !comparisonClaims.length || baselineClaims.some((item) => !item) || comparisonClaims.some((item) => !item)) reason = "DERIVATION_INPUT_REQUIRED";
      else if (hash(declaredInputs) !== hash(actualInputs) || !Number.isFinite(claim.value) || Number(claim.value) !== expected || claim.fact?.value !== expected) reason = "DERIVATION_MISMATCH";
    }
    else if (!semanticClaimValueMatches(claim, claimEvidence)) reason = "EVIDENCE_VALUE_MISMATCH";
    else {
      const support = supportedTokens(claimEvidence);
      const claimTokens = [...tokens(claim.text), ...tokens(String(claim.fact?.value ?? ""))];
      const unsupported = claimTokens.find((token) => !support.has(token));
      if (unsupported) reason = `UNSUPPORTED_TOKEN:${unsupported}`;
    }
    if (reason) rejected.push({ claimId: claim.claimId, reason });
    else acceptedClaimIds.push(claim.claimId);
  }

  return {
    validationId: `validation-${hash({ acceptedClaimIds, rejected }).slice(0, 12)}`,
    status: rejected.length === 0 ? "valid" : acceptedClaimIds.length > 0 ? "repair" : "rejected",
    acceptedClaimIds,
    rejected,
    warnings,
  };
}

export function validateRenderedAnswer({ text, acceptedClaims, evidence }) {
  const claims = Array.isArray(acceptedClaims) ? acceptedClaims : [];
  const evidenceItems = Array.isArray(evidence) ? evidence : [];
  const support = supportedTokens(evidenceItems, claims.map((claim) => claim.text).filter(Boolean).join(" "));
  const unsupported = tokens(text).find((token) => !support.has(token));
  if (unsupported) {
    const error = new Error(`UNSUPPORTED_RENDERED_TOKEN:${unsupported}`);
    error.code = "UNSUPPORTED_RENDERED_TOKEN";
    throw error;
  }
  return { ok: true };
}

export function renderDeterministicFallback({ acceptedClaims, citations = [], assumptions = [], limitations = [] }) {
  const claims = Array.isArray(acceptedClaims) ? acceptedClaims : [];
  const parts = [];
  if (claims.length) parts.push(claims.map((claim) => claim.text).join("\n"));
  if (citations.length) parts.push(`引用: ${citations.map((item) => item.label).join(", ")}`);
  if (assumptions.length) parts.push(`假设: ${assumptions.join("; ")}`);
  if (limitations.length) parts.push(`限制: ${limitations.join("; ")}`);
  return parts.join("\n\n");
}

export function createAnswerEnvelope({ answerId, text, acceptedClaims, citations, assumptions, limitations, groundingStatus, sourceRevisionSet }) {
  const claims = Array.isArray(acceptedClaims) ? acceptedClaims : [];
  const allowedGrounding = ["grounded", "legacy_equivalence", "insufficient_evidence"].includes(groundingStatus) ? groundingStatus : "insufficient_evidence";
  return {
    schemaVersion: "1.0",
    answerId,
    text,
    contentHash: hash(text),
    acceptedClaimIds: claims.map((claim) => claim.claimId),
    citations: citations || [],
    assumptions: assumptions || [],
    limitations: limitations || [],
    groundingStatus: allowedGrounding,
    sourceRevisionSet,
  };
}
