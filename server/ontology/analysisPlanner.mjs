import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, fingerprintSourceQuery, normalizeSourceQuery } from "./fingerprint.mjs";
import { compileSemanticQuery } from "./queryCompiler.mjs";
import { createQueryPlanId, defaultRecordFieldsForEntity, deriveBusinessRuleFrame, fingerprintQueryPlanSteps, validatePlan } from "./queryPlanner.mjs";
import { validateSemanticFrame } from "./semanticFrame.mjs";

const analysisPlanIdSchema = { type: "string", pattern: "^analysis-[a-f0-9]{16}$" };
const sourcePlanIdSchema = { type: "string", pattern: "^plan-[a-f0-9]{16}$" };
const ontologyVersionSchema = { type: "string", pattern: "^v[0-9]+(?:\\.[0-9]+){0,2}$" };
const GOVERNED_ANALYSIS_GUARDRAILS = Object.freeze([
  "READ_ONLY_SOURCE_PLAN",
  "NO_ARBITRARY_CODE",
  "NO_ARBITRARY_SQL",
  "NO_CAUSAL_CLAIMS",
  "CLARIFICATION_REQUIRED",
  "BUSINESS_RULE_DENIED",
  "SIMILARITY_NOT_POPULATION_STATISTIC",
]);
const guardrailArray = { type: "array", minItems: 1, uniqueItems: true, items: { enum: GOVERNED_ANALYSIS_GUARDRAILS } };
const businessRuleCodeArray = { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^BUSINESS_RULE_(?:DENY|REQUIRE):" } };
const businessRuleEffectArray = {
  type: "array",
  uniqueItems: true,
  items: {
    type: "object",
    required: ["ruleId", "kind", "code"],
    additionalProperties: false,
    properties: {
      ruleId: { type: "string", minLength: 1 },
      kind: { enum: ["deny", "require", "derive"] },
      code: { type: "string", minLength: 1 },
    },
  },
};

export const governedAnalysisPlanSchema = Object.freeze({
  type: "object",
  required: ["schemaVersion", "analysisPlanId", "sourcePlanId", "sourcePlanFingerprint", "ontologyVersion", "schemaFingerprint", "status", "operation", "visualization", "maxRows", "guardrails"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    analysisPlanId: analysisPlanIdSchema,
    sourcePlanId: sourcePlanIdSchema,
    sourcePlanFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    ontologyVersion: ontologyVersionSchema,
    schemaFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    status: { enum: ["ready", "needs_clarification", "denied"] },
    operation: { enum: ["none", "kpi_summary", "time_series", "period_comparison", "group_comparison", "ranked_comparison", "record_table", "traceability_table", "similarity_review"] },
    visualization: { enum: ["none", "kpi", "line", "bar", "grouped_bar", "table"] },
    maxRows: { type: "integer", minimum: 0, maximum: 100 },
    guardrails: guardrailArray,
    ruleCodes: businessRuleCodeArray,
    ruleEffects: businessRuleEffectArray,
  },
  allOf: [{
    if: { properties: { status: { const: "denied" } }, required: ["status"] },
    then: { properties: { ruleCodes: businessRuleCodeArray }, required: ["ruleCodes"] },
  }],
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(governedAnalysisPlanSchema);
const BASE_GUARDRAILS = Object.freeze(["READ_ONLY_SOURCE_PLAN", "NO_ARBITRARY_CODE", "NO_ARBITRARY_SQL", "NO_CAUSAL_CLAIMS"]);

function profileFor(frame) {
  if (frame.intent === "trend") return { operation: "time_series", visualization: "line" };
  if (frame.intent === "rank") return { operation: "ranked_comparison", visualization: "bar" };
  if (frame.intent === "compare") return frame.comparison?.kind === "time_periods"
    ? { operation: "period_comparison", visualization: "grouped_bar" }
    : { operation: "group_comparison", visualization: "grouped_bar" };
  if (["list", "drilldown"].includes(frame.intent)) return { operation: "record_table", visualization: "table" };
  if (frame.intent === "trace") return { operation: "traceability_table", visualization: "table" };
  if (frame.intent === "similarity") return { operation: "similarity_review", visualization: "table" };
  return { operation: "kpi_summary", visualization: "kpi" };
}

function rowBudget(frame, visualization) {
  const limit = Number.isInteger(frame.limit) ? frame.limit : 1;
  if (visualization === "kpi") return Math.min(Math.max(limit, 1), 12);
  if (["line", "bar", "grouped_bar"].includes(visualization)) return Math.min(Math.max(limit, 1), 50);
  if (visualization === "table") return Math.min(Math.max(limit, 1), 100);
  return 0;
}

function sourcePlanFingerprint(queryPlan) {
  return createHash("sha256").update(canonicalJson(queryPlan)).digest("hex");
}

function analysisPlanId(frame, sourceFingerprint) {
  return `analysis-${createHash("sha256").update(canonicalJson({ sourceFingerprint, intent: frame.intent, comparison: frame.comparison, limit: frame.limit })).digest("hex").slice(0, 16)}`;
}

function sourceStepProfile(frame) {
  if (frame.intent === "similarity") return { operation: "similarity_search", toolName: "search_duplicates" };
  if (frame.intent === "trace") return { operation: "traceability_query", toolName: "query_traceability" };
  if (["list", "drilldown"].includes(frame.intent)) return { operation: "semantic_record_query", toolName: "query_semantic_records" };
  return { operation: "semantic_metric_query", toolName: "query_semantic_metrics" };
}

function expectedMetricSlices(frame, operation) {
  return operation === "semantic_metric_query" && frame.metricIds.length > 1 ? frame.metricIds.map((metricId) => [metricId]) : [frame.metricIds];
}

function matchingCanonicalArgs(frame, step, operation, metricIds) {
  if (operation === "similarity_search") {
    const canonicalArgs = { query: step.canonicalArgs?.query, top_k: Math.min(20, frame.limit) };
    return typeof canonicalArgs.query === "string" && canonicalJson(step.canonicalArgs) === canonicalJson(canonicalArgs);
  }
  if (operation === "semantic_record_query") {
    const canonicalArgs = {
      ontology_version: frame.ontologyVersion,
      schema_fingerprint: frame.schemaFingerprint,
      query: compileSemanticQuery(frame),
      analysis_ref: null,
      selections: [],
      fields: defaultRecordFieldsForEntity(frame.entityIds[0]),
      page: 1,
      page_size: Math.min(50, frame.limit),
    };
    return canonicalJson(step.canonicalArgs) === canonicalJson(canonicalArgs);
  }
  const query = operation === "semantic_metric_query" ? compileSemanticQuery({ ...frame, metricIds }) : compileSemanticQuery(frame);
  return canonicalJson(step.canonicalArgs) === canonicalJson({ query });
}

function validateSourcePlanSemantics(frame, queryPlan, registry) {
  const businessRuleDenials = queryPlan.violations.filter((code) => String(code).startsWith("BUSINESS_RULE_DENY:"));
  const businessRuleRequirements = queryPlan.violations.filter((code) => String(code).startsWith("BUSINESS_RULE_REQUIRE:"));
  const expectedStatus = businessRuleDenials.length
    ? "denied"
    : businessRuleRequirements.length || frame.ambiguities.length
      ? "needs_clarification"
      : "valid";
  const expectedViolations = expectedStatus === "denied"
    ? businessRuleDenials
    : [...frame.ambiguities.map((item) => item.code), ...businessRuleRequirements];
  if (queryPlan.status !== expectedStatus) throw new Error("ANALYSIS_PLAN_SOURCE_STATUS_INVALID");
  if (queryPlan.version !== 1 || canonicalJson(queryPlan.violations) !== canonicalJson(expectedViolations)) throw new Error("ANALYSIS_PLAN_SOURCE_VIOLATIONS_INVALID");
  if (expectedStatus !== "valid") {
    if (queryPlan.steps.length) throw new Error("ANALYSIS_PLAN_SOURCE_STEPS_INVALID");
    return;
  }
  const executionFrame = registry ? deriveBusinessRuleFrame({ registry, frame }).frame : frame;
  const profile = sourceStepProfile(frame);
  const metricSlices = expectedMetricSlices(executionFrame, profile.operation);
  if (queryPlan.steps.length !== metricSlices.length) throw new Error("ANALYSIS_PLAN_SOURCE_STEPS_INVALID");
  for (const [index, step] of queryPlan.steps.entries()) {
    const metricIds = metricSlices[index];
    const dependsOn = index === 0 ? [] : [`s${index}`];
    if (profile.operation === "similarity_search") {
      const sourceQuery = step.canonicalArgs?.query;
      if (typeof sourceQuery !== "string" || sourceQuery !== normalizeSourceQuery(sourceQuery) || fingerprintSourceQuery(sourceQuery) !== frame.sourceQueryFingerprint) {
        throw new Error("ANALYSIS_PLAN_SOURCE_QUERY_INVALID");
      }
    }
    if (step.stepId !== `s${index + 1}` || step.operation !== profile.operation || step.toolName !== profile.toolName || step.riskLevel !== "R0"
      || canonicalJson(step.metricIds) !== canonicalJson(metricIds) || canonicalJson(step.dimensionIds) !== canonicalJson(executionFrame.dimensionIds)
      || canonicalJson(step.dependsOn) !== canonicalJson(dependsOn) || !matchingCanonicalArgs(executionFrame, step, profile.operation, metricIds)) {
      throw new Error("ANALYSIS_PLAN_SOURCE_STEPS_INVALID");
    }
  }
}

function validateInputs(frame, queryPlan, registry) {
  if (!frame || !queryPlan) throw new Error("ANALYSIS_PLAN_INPUT_REQUIRED");
  const validatedFrame = validateSemanticFrame(frame);
  const validatedQueryPlan = validatePlan(queryPlan);
  if (validatedFrame.ontologyVersion !== validatedQueryPlan.ontologyVersion || validatedFrame.schemaFingerprint !== validatedQueryPlan.schemaFingerprint) throw new Error("ANALYSIS_PLAN_ONTOLOGY_VERSION_MISMATCH");
  if (validatedQueryPlan.sourceQueryFingerprint !== validatedFrame.sourceQueryFingerprint) throw new Error("ANALYSIS_PLAN_SOURCE_QUERY_INVALID");
  if (validatedQueryPlan.planId !== createQueryPlanId({ frame: validatedFrame, actorScopeHash: validatedQueryPlan.actorScopeHash, sourceQueryFingerprint: validatedQueryPlan.sourceQueryFingerprint, executionFingerprint: validatedQueryPlan.executionFingerprint })) {
    throw new Error("ANALYSIS_PLAN_SOURCE_BINDING_INVALID");
  }
  validateSourcePlanSemantics(validatedFrame, validatedQueryPlan, registry);
  if (validatedQueryPlan.executionFingerprint !== fingerprintQueryPlanSteps(validatedQueryPlan.steps)) throw new Error("ANALYSIS_PLAN_SOURCE_EXECUTION_FINGERPRINT_INVALID");
  return { frame: validatedFrame, queryPlan: validatedQueryPlan };
}

export function validateGovernedAnalysisPlan(plan) {
  if (!validate(plan)) throw new Error(`GOVERNED_ANALYSIS_PLAN_INVALID:${ajv.errorsText(validate.errors)}`);
  return plan;
}

export function createGovernedAnalysisPlanner({ registry } = {}) {
  return Object.freeze({
    createPlan({ frame, queryPlan }) {
      const inputs = validateInputs(frame, queryPlan, registry);
      frame = inputs.frame;
      queryPlan = inputs.queryPlan;
      const sourceFingerprint = sourcePlanFingerprint(queryPlan);
      const base = {
        schemaVersion: "1.0",
        analysisPlanId: analysisPlanId(frame, sourceFingerprint),
        sourcePlanId: queryPlan.planId,
        sourcePlanFingerprint: sourceFingerprint,
        ontologyVersion: frame.ontologyVersion,
        schemaFingerprint: frame.schemaFingerprint,
        ruleEffects: [...queryPlan.ruleEffects],
      };
      if (queryPlan.status === "denied") {
        return validateGovernedAnalysisPlan({
          ...base,
          status: "denied",
          operation: "none",
          visualization: "none",
          maxRows: 0,
          guardrails: [...BASE_GUARDRAILS, "BUSINESS_RULE_DENIED"],
          ruleCodes: [...queryPlan.violations],
        });
      }
      if (queryPlan.status !== "valid") {
        const ruleCodes = queryPlan.violations.filter((code) => String(code).startsWith("BUSINESS_RULE_REQUIRE:"));
        return validateGovernedAnalysisPlan({
          ...base,
          status: "needs_clarification",
          operation: "none",
          visualization: "none",
          maxRows: 0,
          guardrails: [...BASE_GUARDRAILS, "CLARIFICATION_REQUIRED"],
          ...(ruleCodes.length ? { ruleCodes } : {}),
        });
      }
      const profile = profileFor(frame);
      const guardrails = [...BASE_GUARDRAILS, ...(frame.intent === "similarity" ? ["SIMILARITY_NOT_POPULATION_STATISTIC"] : [])];
      return validateGovernedAnalysisPlan({ ...base, status: "ready", ...profile, maxRows: rowBudget(frame, profile.visualization), guardrails });
    },
  });
}