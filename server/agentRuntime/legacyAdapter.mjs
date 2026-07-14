import { createRuntimePolicy } from "./policy.mjs";

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function createLegacySemanticAdapter({ timezone = "Asia/Shanghai", now = () => new Date().toISOString() } = {}) {
  return {
    resolve({ query }) {
      const anchor = new Date(now());
      const end = new Date(anchor);
      const start = new Date(anchor);
      start.setUTCDate(end.getUTCDate() - 6);
      const wantsDuplicate = /重复|查重|similar|duplicate/i.test(query);
      const wantsHighFrequency = /高频|集中|recent|最近一周/i.test(query);
      return {
        ref: { ontologyVersion: "legacy-provisional", schemaFingerprint: "legacy-v0", requestAnchorAt: anchor.toISOString() },
        mode: "legacy_provisional",
        intent: wantsDuplicate ? "lookup" : "aggregate",
        objectTypes: ["legacy.defect"],
        metrics: [{ metricId: wantsDuplicate ? "legacy.duplicate_similarity" : "legacy.defect_count", unit: wantsDuplicate ? "score" : "count" }],
        filters: {},
        timeScopes: [{ role: "primary", fieldId: "legacy.creation_time", start: formatDate(start), end: formatDate(end), timezone, anchorAt: anchor.toISOString(), relativeText: /最近一周|recent week|last 7 days/i.test(query) ? "最近一周" : undefined }],
        preferredToolName: wantsDuplicate ? "search_duplicates" : wantsHighFrequency ? "query_defect_high_frequency_analysis" : "query_dashboard_summary",
      };
    },
  };
}

export function validateLegacyPlan({ candidate, actor, request, runtimeMode, policy = createRuntimePolicy() }) {
  const violations = [];
  const steps = [];
  for (const step of candidate.steps || []) {
    try {
      policy.authorizeTool({ actor, request, runtimeMode, toolName: step.toolName, externalStepIndex: steps.length, callsInStep: 1 });
      steps.push({ ...step, toolVersion: "legacy-tool-v1", requiresApproval: false, expectedShape: "scalar" });
    } catch (error) {
      violations.push(error.code || error.message);
    }
  }
  return { status: violations.length ? "denied" : "valid", actorScopeHash: actor.scopeHash, steps, violations, warnings: [] };
}