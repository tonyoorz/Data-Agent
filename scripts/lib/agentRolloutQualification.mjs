import { createHash } from "node:crypto";
import { createRuntimeConfig } from "../../server/agentRuntime/config.mjs";

const SHADOW_ACTIONS = new Set([
  "runtime.shadow_dispatch",
  "runtime.shadow_legacy_result",
  "runtime.shadow_result",
]);

function rate(numerator, denominator, emptyValue = 0) {
  return denominator > 0 ? numerator / denominator : emptyValue;
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).map(Number).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function gate(actual, pass, objective) {
  return { pass: Boolean(pass), actual, objective };
}

function parseDetails(row) {
  if (row.details && typeof row.details === "object") return row.details;
  return JSON.parse(String(row.details_json ?? row.detailsJson ?? "{}"));
}

function reportPass(gates) {
  return Object.values(gates).every((item) => item.pass);
}

function signatureComparison(groups, field) {
  const comparable = groups.filter((group) => (
    typeof group["runtime.shadow_legacy_result"]?.[field] === "string"
    && typeof group["runtime.shadow_result"]?.[field] === "string"
  ));
  const matches = comparable.filter((group) => group["runtime.shadow_legacy_result"][field] === group["runtime.shadow_result"][field]).length;
  return {
    comparable: comparable.length,
    coverage: rate(comparable.length, groups.length, 0),
    matchRate: rate(matches, comparable.length, 0),
  };
}

export function buildShadowQualification(auditRows, {
  minSamples = 100,
  minPairCoverage = 0.99,
  maxRuntimeFailureRate = 0.01,
  maxCompletionRateRegression = 0.01,
  minGroundingPolicyRate = 1,
  minCitationCoverageRate = 1,
  minLatencyPairCoverage = 0.95,
  maxLatencyRegressionPct = 20,
  minSemanticPairCoverage = 0.95,
  minSemanticMatchRate = 0.95,
  minScopePairCoverage = 0.95,
  minScopeMatchRate = 1,
  minToolPairCoverage = 0.95,
  minToolMatchRate = 0.95,
  minNumericPairCoverage = 0.95,
  minNumericMatchRate = 1,
} = {}) {
  const groups = new Map();
  let invalidRows = 0;
  let duplicateActionRows = 0;
  const relevantRows = [];
  for (const row of auditRows || []) {
    const action = String(row.action || "");
    if (!SHADOW_ACTIONS.has(action)) continue;
    const runId = String(row.run_id ?? row.runId ?? "");
    if (!runId) {
      invalidRows += 1;
      continue;
    }
    let details;
    try {
      details = parseDetails(row);
    } catch {
      invalidRows += 1;
      continue;
    }
    const group = groups.get(runId) || { runId };
    if (group[action]) duplicateActionRows += 1;
    group[action] = details;
    group.createdAt = String(row.created_at ?? row.createdAt ?? group.createdAt ?? "");
    groups.set(runId, group);
    relevantRows.push({ action, runId, createdAt: group.createdAt, details });
  }

  const dispatched = [...groups.values()].filter((group) => group["runtime.shadow_dispatch"]);
  const paired = dispatched.filter((group) => group["runtime.shadow_legacy_result"] && group["runtime.shadow_result"]);
  const orphanResultCount = [...groups.values()].filter((group) => !group["runtime.shadow_dispatch"] && (group["runtime.shadow_legacy_result"] || group["runtime.shadow_result"])).length;
  const legacyCompleted = paired.filter((group) => group["runtime.shadow_legacy_result"].status === "completed").length;
  const runtimeCompletedGroups = paired.filter((group) => group["runtime.shadow_result"].status === "completed");
  const runtimeCompleted = runtimeCompletedGroups.length;
  const runtimeFailureRate = rate(paired.length - runtimeCompleted, paired.length, 1);
  const groundingPolicyRate = rate(runtimeCompletedGroups.filter((group) => ["grounded", "insufficient_evidence"].includes(group["runtime.shadow_result"].groundingStatus)).length, runtimeCompleted, 1);
  const claimBearing = runtimeCompletedGroups.filter((group) => Number(group["runtime.shadow_result"].acceptedClaimCount || 0) > 0);
  const citationCoverageRate = rate(claimBearing.filter((group) => Number(group["runtime.shadow_result"].citationCount || 0) > 0).length, claimBearing.length, 1);
  const latencyPairs = paired.filter((group) => Number.isFinite(group["runtime.shadow_legacy_result"].durationMs) && Number.isFinite(group["runtime.shadow_result"].durationMs));
  const legacyP95Ms = percentile(latencyPairs.map((group) => group["runtime.shadow_legacy_result"].durationMs), 0.95);
  const runtimeP95Ms = percentile(latencyPairs.map((group) => group["runtime.shadow_result"].durationMs), 0.95);
  const latencyRegressionPct = legacyP95Ms > 0 && runtimeP95Ms != null ? ((runtimeP95Ms - legacyP95Ms) / legacyP95Ms) * 100 : null;
  const semanticComparison = signatureComparison(paired, "semanticSignature");
  const scopeComparison = signatureComparison(paired, "scopeSignature");
  const toolComparison = signatureComparison(paired, "toolSignature");
  const numericComparison = signatureComparison(paired, "numericSignature");
  const answerHashComparable = paired.filter((group) => group["runtime.shadow_legacy_result"].answerContentHash && group["runtime.shadow_result"].answerContentHash);
  const answerHashMatchRate = rate(answerHashComparable.filter((group) => group["runtime.shadow_legacy_result"].answerContentHash === group["runtime.shadow_result"].answerContentHash).length, answerHashComparable.length, 0);
  const completionRateRegression = rate(legacyCompleted, paired.length, 0) - rate(runtimeCompleted, paired.length, 0);
  const pairCoverage = rate(paired.length, dispatched.length, 0);
  const latencyPairCoverage = rate(latencyPairs.length, paired.length, 0);
  const gates = {
    sampleSize: gate(dispatched.length, dispatched.length >= minSamples, `>= ${minSamples}`),
    auditIntegrity: gate({ invalidRows, duplicateActionRows, orphanResultCount }, invalidRows === 0 && duplicateActionRows === 0 && orphanResultCount === 0, "all zero"),
    pairCoverage: gate(pairCoverage, pairCoverage >= minPairCoverage, `>= ${minPairCoverage}`),
    runtimeFailureRate: gate(runtimeFailureRate, runtimeFailureRate <= maxRuntimeFailureRate, `<= ${maxRuntimeFailureRate}`),
    completionRateRegression: gate(completionRateRegression, completionRateRegression <= maxCompletionRateRegression, `<= ${maxCompletionRateRegression}`),
    groundingPolicyRate: gate(groundingPolicyRate, groundingPolicyRate >= minGroundingPolicyRate, `>= ${minGroundingPolicyRate}`),
    citationCoverageRate: gate(citationCoverageRate, citationCoverageRate >= minCitationCoverageRate, `>= ${minCitationCoverageRate}`),
    latencyPairCoverage: gate(latencyPairCoverage, latencyPairCoverage >= minLatencyPairCoverage, `>= ${minLatencyPairCoverage}`),
    latencyRegressionPct: gate(latencyRegressionPct, latencyRegressionPct != null && latencyRegressionPct <= maxLatencyRegressionPct, `<= ${maxLatencyRegressionPct}`),
    semanticPairCoverage: gate(semanticComparison.coverage, semanticComparison.coverage >= minSemanticPairCoverage, `>= ${minSemanticPairCoverage}`),
    semanticMatchRate: gate(semanticComparison.matchRate, semanticComparison.matchRate >= minSemanticMatchRate, `>= ${minSemanticMatchRate}`),
    scopePairCoverage: gate(scopeComparison.coverage, scopeComparison.coverage >= minScopePairCoverage, `>= ${minScopePairCoverage}`),
    scopeMatchRate: gate(scopeComparison.matchRate, scopeComparison.matchRate >= minScopeMatchRate, `>= ${minScopeMatchRate}`),
    toolPairCoverage: gate(toolComparison.coverage, toolComparison.coverage >= minToolPairCoverage, `>= ${minToolPairCoverage}`),
    toolMatchRate: gate(toolComparison.matchRate, toolComparison.matchRate >= minToolMatchRate, `>= ${minToolMatchRate}`),
    numericPairCoverage: gate(numericComparison.coverage, numericComparison.coverage >= minNumericPairCoverage, `>= ${minNumericPairCoverage}`),
    numericMatchRate: gate(numericComparison.matchRate, numericComparison.matchRate >= minNumericMatchRate, `>= ${minNumericMatchRate}`),
  };
  const createdAtValues = relevantRows.map((row) => row.createdAt).filter(Boolean).sort();
  const sourceDigest = createHash("sha256").update(JSON.stringify(relevantRows.map((row) => ({ action: row.action, runId: row.runId, createdAt: row.createdAt, details: row.details })))).digest("hex");

  return {
    schemaVersion: "1.0",
    qualification: "production-shadow",
    sourceDigest,
    window: { from: createdAtValues[0] || null, to: createdAtValues.at(-1) || null },
    sample: { dispatched: dispatched.length, paired: paired.length, runtimeCompleted, legacyCompleted, claimBearing: claimBearing.length, semanticComparable: semanticComparison.comparable, scopeComparable: scopeComparison.comparable, toolComparable: toolComparison.comparable, numericComparable: numericComparison.comparable },
    metrics: {
      pairCoverage,
      runtimeFailureRate,
      legacyCompletionRate: rate(legacyCompleted, paired.length, 0),
      runtimeCompletionRate: rate(runtimeCompleted, paired.length, 0),
      completionRateRegression,
      groundingPolicyRate,
      citationCoverageRate,
      latencyPairCoverage,
      legacyP95Ms,
      runtimeP95Ms,
      latencyRegressionPct,
      answerHashMatchRate,
      semanticPairCoverage: semanticComparison.coverage,
      semanticMatchRate: semanticComparison.matchRate,
      scopePairCoverage: scopeComparison.coverage,
      scopeMatchRate: scopeComparison.matchRate,
      toolPairCoverage: toolComparison.coverage,
      toolMatchRate: toolComparison.matchRate,
      numericPairCoverage: numericComparison.coverage,
      numericMatchRate: numericComparison.matchRate,
    },
    gates,
    pass: reportPass(gates),
  };
}

export function qualifyCanaryRouting({ actorIds, percentage, allowlist = [], tolerancePercentagePoints = 2.5 } = {}) {
  const allowlisted = [...new Set((allowlist || []).map(String).filter(Boolean))];
  const actors = [...new Set([...(actorIds || []), ...allowlisted].map(String).filter(Boolean))];
  const config = createRuntimeConfig({
    MAIN_AGENT_RUNTIME_MODE: "canary",
    MAIN_AGENT_CANARY_PERCENTAGE: String(percentage ?? 0),
    MAIN_AGENT_CANARY_ACTOR_ALLOWLIST: allowlisted.join(","),
  });
  const first = actors.map((actorId) => config.resolveRuntimeDecision(actorId));
  const second = actors.map((actorId) => config.resolveRuntimeDecision(actorId));
  const allowlistSet = new Set(allowlisted);
  const eligibleIndices = actors.map((actorId, index) => ({ actorId, index })).filter(({ actorId }) => !allowlistSet.has(actorId));
  const selected = eligibleIndices.filter(({ index }) => first[index].runtimeMode === "langgraph").length;
  const actualPercentage = rate(selected, eligibleIndices.length, 0) * 100;
  const expectedPercentage = Number(percentage ?? 0);
  const deviationPercentagePoints = Math.abs(actualPercentage - expectedPercentage);
  const deterministic = first.every((decision, index) => JSON.stringify(decision) === JSON.stringify(second[index]));
  const allowlistCoverage = rate(actors.filter((actorId) => allowlistSet.has(actorId) && config.resolveRuntimeMode(actorId) === "langgraph").length, actors.filter((actorId) => allowlistSet.has(actorId)).length, 1);
  const decisionCoherence = first.every((decision) => decision.agentApiEnabled === (decision.runtimeMode === "langgraph") && decision.serverControlled === true);
  const exactBoundary = expectedPercentage === 0 || expectedPercentage === 100;
  const distributionPass = exactBoundary ? deviationPercentagePoints === 0 : deviationPercentagePoints <= tolerancePercentagePoints;
  const gates = {
    sampleSize: gate(actors.length, actors.length >= 100, ">= 100"),
    deterministic: gate(deterministic, deterministic, "true"),
    allowlistCoverage: gate(allowlistCoverage, allowlistCoverage === 1, "1"),
    decisionCoherence: gate(decisionCoherence, decisionCoherence, "true"),
    distributionDeviationPercentagePoints: gate(deviationPercentagePoints, distributionPass, exactBoundary ? "0" : `<= ${tolerancePercentagePoints}`),
  };
  return {
    schemaVersion: "1.0",
    qualification: "canary-routing",
    sampleSize: actors.length,
    allowlistSize: allowlisted.length,
    expectedPercentage,
    actualPercentage,
    selectedCount: selected,
    gates,
    pass: reportPass(gates),
  };
}

export function qualifyRollbackSwitch({ actorIds } = {}) {
  const actors = [...new Set((actorIds || []).map(String).filter(Boolean))];
  const legacy = createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "legacy" });
  const canaryZero = createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "canary", MAIN_AGENT_CANARY_PERCENTAGE: "0" });
  const langgraph = createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "langgraph" });
  const legacyDecisions = actors.map((actorId) => legacy.resolveRuntimeDecision(actorId));
  const zeroDecisions = actors.map((actorId) => canaryZero.resolveRuntimeDecision(actorId));
  const v2Decisions = actors.map((actorId) => langgraph.resolveRuntimeDecision(actorId));
  const disabled = (decision) => decision.runtimeMode === "legacy" && decision.agentApiEnabled === false && decision.serverControlled === true;
  const enabled = (decision) => decision.runtimeMode === "langgraph" && decision.agentApiEnabled === true && decision.serverControlled === true;
  const gates = {
    sampleSize: gate(actors.length, actors.length >= 3, ">= 3"),
    legacyDisablesAgentApi: gate(legacyDecisions.filter(disabled).length, legacyDecisions.every(disabled), `${actors.length}`),
    canaryZeroDisablesAgentApi: gate(zeroDecisions.filter(disabled).length, zeroDecisions.every(disabled), `${actors.length}`),
    langgraphEnablesAgentApi: gate(v2Decisions.filter(enabled).length, v2Decisions.every(enabled), `${actors.length}`),
  };
  return {
    schemaVersion: "1.0",
    qualification: "rollback-switch",
    sampleSize: actors.length,
    gates,
    pass: reportPass(gates),
  };
}
