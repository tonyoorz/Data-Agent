import { createHash } from "node:crypto";
import { primitiveForLegacyTool } from "./mainAgentPrimitives.mjs";

function parseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return {};
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

const PRIMITIVE_EVIDENCE_KINDS = Object.freeze({
  catalog: "catalog_snapshot",
  resolve: "resolution_set",
  analyze: "metric_result",
  records: "record_set",
  trace: "lineage_set",
  duplicate_search: "similarity_candidates",
  prepare_testcase: "testcase_proposal",
});

const BACKEND_EVIDENCE_KINDS = Object.freeze({
  semantic_metric_result: "metric_result",
  semantic_record_set: "record_set",
  semantic_lineage_result: "lineage_set",
  semantic_lineage_set: "lineage_set",
});

const CLAIM_BEARING_EVIDENCE_KINDS = new Set([
  "metric_result",
  "record_set",
  "lineage_set",
  "similarity_candidates",
  "testcase_proposal",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadDigest(value) {
  return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex");
}

function evidenceKind({ primitive, backendKind }) {
  return BACKEND_EVIDENCE_KINDS[backendKind] || PRIMITIVE_EVIDENCE_KINDS[primitive] || "";
}

export function isClaimBearingEvidence(item) {
  const legacyKind = BACKEND_EVIDENCE_KINDS[item?.evidence?.kind]
    || (item?.tool === "query_semantic_metrics" ? "metric_result" : "")
    || (item?.tool === "query_semantic_records" ? "record_set" : "")
    || (item?.tool === "query_traceability" ? "lineage_set" : "");
  return CLAIM_BEARING_EVIDENCE_KINDS.has(String(item?.evidenceKind || item?.evidenceEnvelope?.kind || legacyKind));
}

export function buildToolEvidence({ toolCall, result, intent, actorScope }) {
  const payload = parseJson(result?.toolMessage?.content);
  const body = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const tool = payload?.tool || result?.toolMessage?.name || toolCall?.function?.name || "unknown_tool";
  const primitive = payload?.primitive || (PRIMITIVE_EVIDENCE_KINDS[tool] ? tool : primitiveForLegacyTool(tool) || undefined);
  const adapterTool = payload?.adapterTool || result?.adapterTool || (primitive && primitive !== tool ? tool : undefined);
  const backendKind = body?.evidence?.kind;
  const data = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.rows) ? body.rows
      : Array.isArray(body?.frequency_rows) ? body.frequency_rows
        : Array.isArray(body?.candidates) ? body.candidates
          : undefined;
  const kind = evidenceKind({ primitive, backendKind });
  const toolCallId = toolCall?.id || result?.toolMessage?.tool_call_id || "";
  const evidenceEnvelope = kind ? compactObject({
    schemaVersion: "1.0",
    kind,
    toolCallId,
    primitive,
    operation: payload?.operation || result?.operation,
    adapterTool,
    payloadDigest: payloadDigest(body),
    sourceLocator: payload?.url || body?.sourceRevision?.revisionId || body?.snapshot_version
      || (body?.proposalDigest ? `testcase-proposal:${body.proposalDigest}` : adapterTool),
    sourceRevisionId: body?.sourceRevision?.revisionId || body?.snapshot_version,
    analysisRef: body?.analysisRef || body?.query_fingerprint,
    actorScopeHash: body?.scope?.actorScopeHash || actorScope?.scopeHash,
    backendEvidence: body?.evidence,
  }) : undefined;
  return compactObject({
    tool,
    primitive,
    operation: payload?.operation || result?.operation,
    adapterTool,
    evidenceKind: kind,
    evidenceEnvelope,
    toolCallId,
    intent,
    ok: payload?.ok,
    ontologyVersion: body?.ontologyVersion,
    schemaFingerprint: body?.schemaFingerprint,
    analysisRef: body?.analysisRef || body?.query_fingerprint,
    sourceRevision: body?.sourceRevision || (body?.snapshot_version
      ? { revisionId: body.snapshot_version, status: "pinned" }
      : undefined),
    scope: body?.scope || (actorScope?.scopeHash ? { actorScopeHash: actorScope.scopeHash } : undefined),
    summary: body?.summary,
    data,
    pagination: body?.pagination,
    quality: body?.quality,
    evidence: body?.evidence,
    limitations: body?.limitations,
    url: payload?.url,
  });
}

const CLAIM_BEARING_SEMANTIC_TOOLS = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);
const NON_CLAIM_BEARING_TOOLS = new Set([
  "catalog",
  "resolve",
  "ask_clarification",
  "get_data_catalog",
  "get_ontology_catalog",
  "search_octane_fields",
  "resolve_business_terms",
]);

function emptyEvidenceGate() {
  return { status: "not_required", violations: [], analysisRefs: [], sourceRevisionIds: [], warnings: [] };
}

export function evaluateSemanticEvidence(items, {
  expectedActorScopeHash = "",
  expectedSourceRevisionIds = [],
  requireReleaseBinding = false,
} = {}) {
  const claimItems = (Array.isArray(items) ? items : []).filter(isClaimBearingEvidence);
  if (!claimItems.length) {
    return emptyEvidenceGate();
  }
  const violations = [];
  const analysisRefs = [];
  const sourceRevisionIds = [];
  const warnings = [];
  const revisionsByAnalysisRef = new Map();
  const expectedRevisions = [...new Set((Array.isArray(expectedSourceRevisionIds) ? expectedSourceRevisionIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
  if (requireReleaseBinding && !String(expectedActorScopeHash || "").trim()) {
    violations.push("SEMANTIC_EXPECTED_SCOPE_MISSING");
  }
  if (requireReleaseBinding && expectedRevisions.length === 0) {
    violations.push("SEMANTIC_EXPECTED_SOURCE_REVISION_MISSING");
  }
  for (const item of claimItems) {
    const legacySemantic = CLAIM_BEARING_SEMANTIC_TOOLS.has(item?.tool);
    const semanticAdapter = legacySemantic
      || ["query_semantic_metrics", "query_semantic_records", "query_traceability"].includes(item?.adapterTool);
    const envelope = item?.evidenceEnvelope || {};
    if (item?.ok !== true) violations.push(semanticAdapter ? "SEMANTIC_TOOL_RESULT_FAILED" : "EVIDENCE_TOOL_RESULT_FAILED");
    if (!legacySemantic && !envelope?.kind) violations.push("EVIDENCE_KIND_MISSING");
    if (!legacySemantic && !envelope?.payloadDigest) violations.push("EVIDENCE_PAYLOAD_DIGEST_MISSING");
    if (!legacySemantic && !envelope?.sourceLocator) violations.push("EVIDENCE_SOURCE_LOCATOR_MISSING");
    if ((requireReleaseBinding || expectedActorScopeHash) && !item?.scope?.actorScopeHash) {
      violations.push(semanticAdapter ? "SEMANTIC_SCOPE_EVIDENCE_MISSING" : "EVIDENCE_SCOPE_MISSING");
    }
    if (expectedActorScopeHash && item?.scope?.actorScopeHash
      && item.scope.actorScopeHash !== expectedActorScopeHash) {
      violations.push(semanticAdapter ? "SEMANTIC_SCOPE_EVIDENCE_MISMATCH" : "EVIDENCE_SCOPE_MISMATCH");
    }
    if (semanticAdapter) {
      if (!item?.ontologyVersion) violations.push("SEMANTIC_ONTOLOGY_VERSION_MISSING");
      if (!item?.schemaFingerprint) violations.push("SEMANTIC_SCHEMA_FINGERPRINT_MISSING");
      if (!item?.analysisRef) violations.push("SEMANTIC_ANALYSIS_REF_MISSING");
      if (!item?.sourceRevision?.revisionId) violations.push("SEMANTIC_SOURCE_REVISION_MISSING");
      if (!item?.quality?.completeness) violations.push("SEMANTIC_QUALITY_EVIDENCE_MISSING");
      if (!item?.evidence?.kind) violations.push("SEMANTIC_BACKEND_EVIDENCE_MISSING");
      const semanticTool = String(item?.adapterTool || item?.tool || "");
      const expectedKind = semanticTool === "query_semantic_records"
        ? "semantic_record_set"
        : semanticTool === "query_traceability"
          ? "semantic_lineage_result"
          : "semantic_metric_result";
      if (item?.evidence?.kind && item.evidence.kind !== expectedKind) {
        violations.push("SEMANTIC_BACKEND_EVIDENCE_KIND_INVALID");
      }
    }
    if (item?.analysisRef && item?.evidence?.analysisRef && item.analysisRef !== item.evidence.analysisRef) {
      violations.push("SEMANTIC_ANALYSIS_REF_MISMATCH");
    }
    if (item?.sourceRevision?.revisionId && item?.evidence?.sourceRevisionId
      && item.sourceRevision.revisionId !== item.evidence.sourceRevisionId) {
      violations.push("SEMANTIC_SOURCE_REVISION_MISMATCH");
    }
    if (item?.analysisRef) analysisRefs.push(String(item.analysisRef));
    if (item?.sourceRevision?.revisionId) {
      const revisionId = String(item.sourceRevision.revisionId);
      sourceRevisionIds.push(revisionId);
      if (item?.analysisRef) {
        const ref = String(item.analysisRef);
        const revisions = revisionsByAnalysisRef.get(ref) || new Set();
        revisions.add(revisionId);
        revisionsByAnalysisRef.set(ref, revisions);
      }
    }
    for (const warning of item?.quality?.warnings || []) warnings.push(String(warning));
  }
  if ([...revisionsByAnalysisRef.values()].some((revisions) => revisions.size > 1)) {
    violations.push("SEMANTIC_ANALYSIS_REVISION_INCONSISTENT");
  }
  const actualRevisions = [...new Set(sourceRevisionIds)].sort();
  if (expectedRevisions.length > 0
    && (actualRevisions.length !== expectedRevisions.length
      || actualRevisions.some((revisionId, index) => revisionId !== expectedRevisions[index]))) {
    violations.push("SEMANTIC_SOURCE_REVISION_EXPECTATION_MISMATCH");
  }
  return {
    status: violations.length ? "blocked" : "pass",
    violations: [...new Set(violations)],
    analysisRefs: [...new Set(analysisRefs)],
    sourceRevisionIds: [...new Set(sourceRevisionIds)],
    warnings: [...new Set(warnings)],
  };
}

export function evaluateClaimEvidence(items, options = {}) {
  const executedToolCalls = Array.isArray(options.executedToolCalls) ? options.executedToolCalls : null;
  const allItems = Array.isArray(items) ? items : [];
  const allToolCalls = executedToolCalls || [];
  const claimItems = allItems.filter(isClaimBearingEvidence);
  if (!allItems.length && !allToolCalls.length) {
    return emptyEvidenceGate();
  }

  const unsupportedItems = allItems.filter((item) => {
    const tool = String(item?.tool || "").trim();
    return !isClaimBearingEvidence(item) && !NON_CLAIM_BEARING_TOOLS.has(tool);
  });
  const semanticGate = claimItems.length ? evaluateSemanticEvidence(claimItems, options) : emptyEvidenceGate();
  const evidenceKeys = new Map();
  const evidenceIdCounts = new Map();
  const evidenceIdViolations = [];
  for (const item of allItems) {
    const id = String(item?.toolCallId || "").trim();
    const tool = String(item?.tool || "unknown_tool").trim() || "unknown_tool";
    if (!id) {
      evidenceIdViolations.push(`CLAIM_EVIDENCE_TOOL_CALL_ID_MISSING:${tool}`);
      continue;
    }
    const key = `${id}\u0000${tool}`;
    evidenceKeys.set(key, Number(evidenceKeys.get(key) || 0) + 1);
    evidenceIdCounts.set(id, Number(evidenceIdCounts.get(id) || 0) + 1);
  }
  const toolCallCounts = new Map();
  const toolCallIdCounts = new Map();
  const toolCallIdViolations = [];
  for (const toolCall of allToolCalls) {
    const id = String(toolCall?.id || "").trim();
    const tool = String(toolCall?.function?.name || "unknown_tool").trim() || "unknown_tool";
    if (!id) {
      toolCallIdViolations.push(`CLAIM_TOOL_CALL_ID_MISSING:${tool}`);
      continue;
    }
    const key = `${id}\u0000${tool}`;
    toolCallCounts.set(key, Number(toolCallCounts.get(key) || 0) + 1);
    toolCallIdCounts.set(id, Number(toolCallIdCounts.get(id) || 0) + 1);
  }
  const violations = [
    ...semanticGate.violations,
    ...toolCallIdViolations,
    ...evidenceIdViolations,
    ...[...toolCallIdCounts.entries()].flatMap(([id, count]) => count > 1 ? [`CLAIM_TOOL_CALL_ID_DUPLICATE:${id}`] : []),
    ...[...evidenceIdCounts.entries()].flatMap(([id, count]) => count > 1 ? [`CLAIM_EVIDENCE_TOOL_CALL_ID_DUPLICATE:${id}`] : []),
    ...unsupportedItems.map((item) => `CLAIM_TOOL_RELEASE_CONTRACT_MISSING:${String(item?.tool || "unknown_tool").trim() || "unknown_tool"}`),
    ...(executedToolCalls ? [...toolCallCounts.entries()].flatMap(([key, count]) => {
      if (Number(evidenceKeys.get(key) || 0) >= count) return [];
      const [rawId, tool] = key.split("\u0000");
      return [`CLAIM_TOOL_EVIDENCE_MISSING:${rawId || "missing"}/${tool}`];
    }) : []),
    ...allItems.flatMap((item) => {
      const id = String(item?.toolCallId || "").trim();
      const tool = String(item?.tool || "unknown_tool").trim() || "unknown_tool";
      if (!id) return [];
      const count = evidenceKeys.get(`${id}\u0000${tool}`) || 0;
      return [
        ...(count > 1 ? [`CLAIM_TOOL_EVIDENCE_DUPLICATE:${id}/${tool}`] : []),
        ...(executedToolCalls && !toolCallCounts.has(`${id}\u0000${tool}`)
          ? [`CLAIM_EVIDENCE_TOOL_CALL_UNKNOWN:${id}/${tool}`]
          : []),
      ];
    }),
  ];
  return {
    status: violations.length ? "blocked" : semanticGate.status,
    violations: [...new Set(violations)],
    analysisRefs: semanticGate.analysisRefs,
    sourceRevisionIds: semanticGate.sourceRevisionIds,
    warnings: semanticGate.warnings,
  };
}

export function formatSemanticEvidenceGate(gate) {
  if (!gate || gate.status === "not_required") return "";
  if (gate.status === "blocked") {
    return [
      "# Claim/evidence gate",
      "Status: BLOCKED",
      `Violations: ${(gate.violations || []).join(", ") || "unknown"}`,
      "Do not state numerical or record-level claims. Explain that governed evidence is unavailable and ask to retry or narrow the query.",
    ].join("\n");
  }
  return [
    "# Claim/evidence gate",
    "Status: PASS",
    `Analysis refs: ${(gate.analysisRefs || []).join(", ")}`,
    `Source revisions: ${(gate.sourceRevisionIds || []).join(", ")}`,
    ...(gate.warnings?.length ? [`Warnings to disclose: ${gate.warnings.join(", ")}`] : []),
    "Every numerical or record-level claim must be directly supported by the returned semantic evidence envelope.",
  ].join("\n");
}

export function buildSemanticContinuationContext(items, actorScope) {
  const scopeHash = String(actorScope?.scopeHash || "");
  if (!scopeHash) return "";
  const semanticItems = (Array.isArray(items) ? items : []).filter((item) => {
    const kind = item?.evidenceKind || BACKEND_EVIDENCE_KINDS[item?.evidence?.kind];
    return ["metric_result", "record_set"].includes(kind) && item?.analysisRef;
  });
  const candidate = [...semanticItems].reverse().find((item) => item?.scope?.actorScopeHash === scopeHash
    && evaluateSemanticEvidence([item]).status === "pass");
  if (!candidate) return "";
  return [
    "# Governed semantic continuation",
    `analysis_ref: ${candidate.analysisRef}`,
    `ontology_version: ${candidate.ontologyVersion}`,
    `schema_fingerprint: ${candidate.schemaFingerprint}`,
    `source_revision: ${candidate.sourceRevision.revisionId}`,
    "For an elliptical records drilldown, pass this analysis_ref to the records primitive. It is context only, not permission; never widen its filters or time scope.",
  ].join("\n");
}
