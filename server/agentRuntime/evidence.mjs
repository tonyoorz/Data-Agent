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

function missingness(payload) {
  const value = payload?.overview?.ticket_count ?? payload?.ticket_count ?? payload?.count;
  if (value === 0) return "zero";
  if (value == null && payload && typeof payload === "object" && !("unparsed" in payload)) return "missing";
  if (payload?.unparsed != null) return "unknown";
  return "not_applicable";
}

export function createLegacyEvidence(input) {
  const payload = parseContent(input.rawResult);
  const duplicate = input.toolName === "search_duplicates";
  const contextText = String(input.rawResult?.contextText || "");
  const preview = { payload, contextText: contextText.slice(0, 20000) };
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
  const allowedGrounding = groundingStatus === "insufficient_evidence" ? "insufficient_evidence" : "legacy_equivalence";
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