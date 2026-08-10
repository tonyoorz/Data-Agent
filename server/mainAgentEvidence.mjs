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

export function buildToolEvidence({ toolCall, result, intent }) {
  const payload = parseJson(result?.toolMessage?.content);
  const body = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  return compactObject({
    tool: payload?.tool || result?.toolMessage?.name || toolCall?.function?.name || "unknown_tool",
    toolCallId: toolCall?.id || result?.toolMessage?.tool_call_id || "",
    intent,
    ok: payload?.ok,
    ontologyVersion: body?.ontologyVersion,
    schemaFingerprint: body?.schemaFingerprint,
    analysisRef: body?.analysisRef,
    sourceRevision: body?.sourceRevision,
    scope: body?.scope,
    summary: body?.summary,
    quality: body?.quality,
    evidence: body?.evidence,
    limitations: body?.limitations,
    url: payload?.url,
  });
}

const CLAIM_BEARING_SEMANTIC_TOOLS = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);

export function evaluateSemanticEvidence(items, {
  expectedActorScopeHash = "",
  expectedSourceRevisionIds = [],
  requireReleaseBinding = false,
} = {}) {
  const semanticItems = (Array.isArray(items) ? items : []).filter((item) => CLAIM_BEARING_SEMANTIC_TOOLS.has(item?.tool));
  if (!semanticItems.length) {
    return { status: "not_required", violations: [], analysisRefs: [], sourceRevisionIds: [], warnings: [] };
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
  for (const item of semanticItems) {
    if (item?.ok !== true) violations.push("SEMANTIC_TOOL_RESULT_FAILED");
    if (!item?.ontologyVersion) violations.push("SEMANTIC_ONTOLOGY_VERSION_MISSING");
    if (!item?.schemaFingerprint) violations.push("SEMANTIC_SCHEMA_FINGERPRINT_MISSING");
    if (!item?.analysisRef) violations.push("SEMANTIC_ANALYSIS_REF_MISSING");
    if (!item?.sourceRevision?.revisionId) violations.push("SEMANTIC_SOURCE_REVISION_MISSING");
    if (!item?.scope?.actorScopeHash) violations.push("SEMANTIC_SCOPE_EVIDENCE_MISSING");
    if (expectedActorScopeHash && item?.scope?.actorScopeHash
      && item.scope.actorScopeHash !== expectedActorScopeHash) {
      violations.push("SEMANTIC_SCOPE_EVIDENCE_MISMATCH");
    }
    if (!item?.quality?.completeness) violations.push("SEMANTIC_QUALITY_EVIDENCE_MISSING");
    if (!item?.evidence?.kind) violations.push("SEMANTIC_BACKEND_EVIDENCE_MISSING");
    const expectedKind = item?.tool === "query_semantic_records"
      ? "semantic_record_set"
      : item?.tool === "query_traceability"
        ? "semantic_lineage_result"
        : "semantic_metric_result";
    if (item?.evidence?.kind && item.evidence.kind !== expectedKind) {
      violations.push("SEMANTIC_BACKEND_EVIDENCE_KIND_INVALID");
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
  const semanticItems = (Array.isArray(items) ? items : []).filter((item) => (
    item?.tool === "query_semantic_metrics" || item?.tool === "query_semantic_records"
  ));
  const candidate = [...semanticItems].reverse().find((item) => item?.scope?.actorScopeHash === scopeHash
    && evaluateSemanticEvidence([item]).status === "pass");
  if (!candidate) return "";
  return [
    "# Governed semantic continuation",
    `analysis_ref: ${candidate.analysisRef}`,
    `ontology_version: ${candidate.ontologyVersion}`,
    `schema_fingerprint: ${candidate.schemaFingerprint}`,
    `source_revision: ${candidate.sourceRevision.revisionId}`,
    "For an elliptical records drilldown, pass this analysis_ref to query_semantic_records. It is context only, not permission; never widen its filters or time scope.",
  ].join("\n");
}
