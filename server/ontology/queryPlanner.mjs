import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, fingerprintSourceQuery, normalizeSourceQuery } from "./fingerprint.mjs";
import { compileSemanticQuery } from "./queryCompiler.mjs";
import { assertOntologyScopeAccess } from "./scopePolicy.mjs";

const string = { type: "string", minLength: 1 };
const queryPlanSchema = {
  type: "object",
  required: ["schemaVersion", "planId", "version", "status", "ontologyVersion", "schemaFingerprint", "actorScopeHash", "sourceQueryFingerprint", "executionFingerprint", "steps", "violations", "warnings"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    planId: string,
    version: { type: "integer", minimum: 1 },
    status: { enum: ["valid", "needs_clarification", "denied"] },
    ontologyVersion: string,
    schemaFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    actorScopeHash: string,
    sourceQueryFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    executionFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["stepId", "operation", "toolName", "metricIds", "dimensionIds", "canonicalArgs", "dependsOn", "riskLevel"],
        additionalProperties: false,
        properties: {
          stepId: string,
          operation: { enum: ["semantic_metric_query", "semantic_record_query", "traceability_query", "similarity_search"] },
          toolName: { enum: ["query_semantic_metrics", "query_semantic_records", "query_traceability", "search_duplicates"] },
          metricIds: { type: "array", items: string },
          dimensionIds: { type: "array", items: string },
          canonicalArgs: { type: "object", additionalProperties: true },
          dependsOn: { type: "array", items: string },
          riskLevel: { const: "R0" },
        },
      },
    },
    violations: { type: "array", items: string },
    warnings: { type: "array", items: string },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(queryPlanSchema);

const DEFAULT_RECORD_FIELDS = Object.freeze({
  "quality.defect": ["defect_id", "name", "status", "assigned_ecu", "problem_finder_team", "creation_time"],
  "testing.test_run": ["mr_id", "test_id", "test_name", "status", "team", "finished"],
  "testing.test_case": ["test_id", "test_name", "project", "pu", "aida", "trace_status"],
});

export function defaultRecordFieldsForEntity(entityId) {
  return [...(DEFAULT_RECORD_FIELDS[entityId] || [])];
}

function validatePlan(plan) {
  if (!validate(plan)) throw new Error(`QUERY_PLAN_INVALID:${ajv.errorsText(validate.errors)}`);
  return plan;
}

export function fingerprintQueryPlanSteps(steps) {
  return createHash("sha256").update(canonicalJson(steps || [])).digest("hex");
}

export function createQueryPlanId({ frame, actorScopeHash, sourceQueryFingerprint, executionFingerprint }) {
  return `plan-${createHash("sha256").update(canonicalJson({ frame, actorScopeHash, sourceQueryFingerprint, executionFingerprint })).digest("hex").slice(0, 16)}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function completePlan({ base, frame, actorScopeHash, status, steps, violations }) {
  const executionFingerprint = fingerprintQueryPlanSteps(steps);
  return validatePlan({
    ...base,
    planId: createQueryPlanId({ frame, actorScopeHash, sourceQueryFingerprint: base.sourceQueryFingerprint, executionFingerprint }),
    executionFingerprint,
    status,
    steps,
    violations,
  });
}

function matchingBusinessRuleWarnings(registry, frame) {
  if (typeof registry.listBusinessRules !== "function") return [];
  const metricIds = new Set(frame.metricIds || []);
  return registry.listBusinessRules({ status: "approved", kind: "plan_warning" })
    .filter((rule) => {
      const appliesTo = rule.appliesTo || {};
      const ruleMetricIds = appliesTo.metricIds || [];
      const ruleIntents = appliesTo.intents || [];
      return (!ruleMetricIds.length || ruleMetricIds.some((metricId) => metricIds.has(metricId)))
        && (!ruleIntents.length || ruleIntents.includes(frame.intent));
    })
    .map((rule) => rule.effect?.warningCode || `BUSINESS_RULE:${rule.id}`);
}

function enabledConstraintWarning(registry, id) {
  try {
    const constraint = registry.getConstraint(id);
    return constraint.parameters?.enabled === false ? null : `CONSTRAINT:${id}`;
  } catch {
    return null;
  }
}

function matchingConstraintWarnings(registry, frame) {
  return [
    enabledConstraintWarning(registry, "planner.forbid_arbitrary_sql"),
    frame.intent === "similarity" ? enabledConstraintWarning(registry, "similarity.not_population_statistic") : null,
  ].filter(Boolean);
}

function traceRelationshipWarnings(registry, frame) {
  if (frame.intent !== "trace" || typeof registry.findRelationshipPath !== "function") return [];
  const entityIds = new Set(frame.entityIds || []);
  const path = entityIds.has("requirements.aida_node") && entityIds.has("quality.defect")
    ? registry.findRelationshipPath("requirements.aida_node", "quality.defect")
    : [];
  return path.length ? [`RELATIONSHIP_PATH:${path.map((relationship) => relationship.id).join(">")}`] : [];
}

export function createQueryPlanner({ registry } = {}) {
  if (!registry) throw new Error("ONTOLOGY_REGISTRY_REQUIRED");
  return Object.freeze({
    createPlan({ frame, actor, query }) {
      const sourceQuery = normalizeSourceQuery(query);
      if (frame.schemaFingerprint !== registry.fingerprint || frame.ontologyVersion !== registry.version) {
        throw new Error("SEMANTIC_ONTOLOGY_VERSION_MISMATCH");
      }
      if (frame.intent === "similarity" && fingerprintSourceQuery(sourceQuery) !== frame.sourceQueryFingerprint) {
        throw new Error("QUERY_PLAN_SOURCE_QUERY_MISMATCH");
      }
      assertOntologyScopeAccess({ actor, frame, registry });
      const actorScopeHash = String(actor?.scopeHash || "missing-scope-hash");
      const warnings = unique([
        ...frame.assumptions,
        ...matchingBusinessRuleWarnings(registry, frame),
        ...matchingConstraintWarnings(registry, frame),
        ...traceRelationshipWarnings(registry, frame),
      ]);
      const base = {
        schemaVersion: "1.0",
        version: 1,
        ontologyVersion: frame.ontologyVersion,
        schemaFingerprint: frame.schemaFingerprint,
        actorScopeHash,
        sourceQueryFingerprint: frame.sourceQueryFingerprint,
        violations: [],
        warnings,
      };
      if (frame.ambiguities.length) {
        return completePlan({
          base,
          frame,
          actorScopeHash,
          status: "needs_clarification",
          steps: [],
          violations: frame.ambiguities.map((item) => item.code),
        });
      }
      const metricConstraint = registry.getConstraint("planner.approved_metric_only");
      for (const metricId of frame.metricIds) {
        const metric = registry.getMetric(metricId, { approvedOnly: metricConstraint.parameters.enabled !== false });
        const presentFilters = new Set(frame.filters.filter((item) => Array.isArray(item.values) && item.values.length).map((item) => item.dimensionId));
        for (const requiredFilter of metric.requiredFilters || []) {
          if (!presentFilters.has(requiredFilter)) throw new Error(`SEMANTIC_METRIC_REQUIRED_FILTER_MISSING:${metric.id}:${requiredFilter}`);
        }
      }
      const maximumLimit = registry.getConstraint("query.max_limit").parameters.maximum;
      if (frame.limit > maximumLimit) throw new Error(`QUERY_LIMIT_EXCEEDED:${maximumLimit}`);

      let operation = "semantic_metric_query";
      let toolName = "query_semantic_metrics";
      let canonicalArgs;
      if (frame.intent === "similarity") {
        operation = "similarity_search";
        toolName = "search_duplicates";
        canonicalArgs = { query: sourceQuery, top_k: Math.min(20, frame.limit) };
      } else if (frame.intent === "trace") {
        operation = "traceability_query";
        toolName = "query_traceability";
        canonicalArgs = { query: compileSemanticQuery(frame) };
      } else if (["list", "drilldown"].includes(frame.intent)) {
        operation = "semantic_record_query";
        toolName = "query_semantic_records";
        const entityId = frame.entityIds[0];
        canonicalArgs = {
          ontology_version: frame.ontologyVersion,
          schema_fingerprint: frame.schemaFingerprint,
          query: compileSemanticQuery(frame),
          analysis_ref: null,
          selections: [],
          fields: defaultRecordFieldsForEntity(entityId),
          page: 1,
          page_size: Math.min(50, frame.limit),
        };
      } else {
        canonicalArgs = { query: compileSemanticQuery(frame) };
      }
      const capability = registry.getPolicy("analytics.read_only");
      if (!capability.allowedOperations.includes(operation)) throw new Error(`PLAN_OPERATION_DENIED:${operation}`);
      const metricSlices = operation === "semantic_metric_query" && frame.metricIds.length > 1
        ? frame.metricIds.map((metricId) => [metricId])
        : [frame.metricIds];
      const steps = metricSlices.map((metricIds, index) => ({
        stepId: `s${index + 1}`,
        operation,
        toolName,
        metricIds,
        dimensionIds: frame.dimensionIds,
        canonicalArgs: operation === "semantic_metric_query"
          ? { query: compileSemanticQuery({ ...frame, metricIds }) }
          : canonicalArgs,
        dependsOn: index === 0 ? [] : [`s${index}`],
        riskLevel: "R0",
      }));
      return completePlan({
        base,
        frame,
        actorScopeHash,
        status: "valid",
        steps,
        violations: [],
      });
    },
  });
}

export { queryPlanSchema, validatePlan };
