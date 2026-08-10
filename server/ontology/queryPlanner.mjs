import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, fingerprintSourceQuery, normalizeSourceQuery } from "./fingerprint.mjs";
import { compileSemanticQuery } from "./queryCompiler.mjs";
import { assertOntologyScopeAccess } from "./scopePolicy.mjs";

const string = { type: "string", minLength: 1 };
const queryPlanSchema = {
  type: "object",
  required: ["schemaVersion", "planId", "version", "status", "ontologyVersion", "schemaFingerprint", "actorScopeHash", "sourceQueryFingerprint", "executionFingerprint", "steps", "violations", "warnings", "ruleEffects"],
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
    ruleEffects: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        required: ["ruleId", "kind", "code"],
        additionalProperties: false,
        properties: {
          ruleId: string,
          kind: { enum: ["deny", "require", "derive"] },
          code: string,
        },
      },
    },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(queryPlanSchema);

const DEFAULT_RECORD_FIELDS = Object.freeze({
  "quality.defect": ["defect_id", "name", "status", "assigned_ecu", "problem_finder_team", "creation_time", "reporting_class", "problem_severity"],
  "testing.test_run": ["mr_id", "test_id", "test_name", "status", "team", "finished"],
  "testing.test_case": ["test_id", "test_name", "project", "pu", "aida", "trace_status"],
});
const TRACE_LINEAGE_RELATIONSHIPS = Object.freeze([
  {
    sourceEntity: "requirements.aida_node",
    targetEntity: "testing.test_case",
    relationshipId: "testing.test_case.validates.aida_node",
  },
  {
    sourceEntity: "testing.test_case",
    targetEntity: "testing.test_run",
    relationshipId: "testing.test_run.executes.test_case",
  },
  {
    sourceEntity: "testing.test_run",
    targetEntity: "quality.defect",
    relationshipId: "quality.defect.detected_in.test_run",
  },
]);

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

function matchingBusinessRules(registry, frame, kind) {
  if (typeof registry.listBusinessRules !== "function") return [];
  const metricIds = new Set(frame.metricIds || []);
  return registry.listBusinessRules({ status: "approved", kind })
    .filter((rule) => {
      const appliesTo = rule.appliesTo || {};
      const ruleMetricIds = appliesTo.metricIds || [];
      const ruleIntents = appliesTo.intents || [];
      return (!ruleMetricIds.length || ruleMetricIds.some((metricId) => metricIds.has(metricId)))
        && (!ruleIntents.length || ruleIntents.includes(frame.intent));
    });
}

function matchingBusinessRuleWarnings(registry, frame) {
  return matchingBusinessRules(registry, frame, "plan_warning")
    .map((rule) => rule.effect?.warningCode || `BUSINESS_RULE:${rule.id}`);
}

function businessRuleEffectCode(rule) {
  if (rule.kind === "deny") return rule.effect?.denialCode || `BUSINESS_RULE_DENY:${rule.id}`;
  return `BUSINESS_RULE_${String(rule.kind || "").toUpperCase()}:${rule.id}`;
}

function matchingEnforcedBusinessRuleEffects(registry, frame) {
  return ["deny", "require", "derive"]
    .flatMap((kind) => matchingBusinessRules(registry, frame, kind))
    .map((rule) => ({ ruleId: rule.id, kind: rule.kind, code: businessRuleEffectCode(rule) }));
}

function timeFieldsReferencedBy(frame) {
  return unique([
    ...(frame.timeScopes || []).map((scope) => scope.fieldId),
    ...(frame.dimensionIds || []).filter((dimensionId) => String(dimensionId).startsWith("time.")),
    ...(frame.filters || []).map((filter) => filter.dimensionId).filter((dimensionId) => String(dimensionId).startsWith("time.")),
    ...(frame.sort || []).map((sort) => sort.fieldId).filter((fieldId) => String(fieldId).startsWith("time.")),
  ]);
}

function matchingBusinessRuleRequirements(registry, frame) {
  const referencedTimeFields = timeFieldsReferencedBy(frame);
  return matchingBusinessRules(registry, frame, "require")
    .filter((rule) => {
      const requiredTimeField = String(rule.effect?.requiredTimeField || "");
      return referencedTimeFields.some((fieldId) => fieldId !== requiredTimeField);
    })
    .map((rule) => `BUSINESS_RULE_REQUIRE:${rule.id}`);
}

function matchingBusinessRuleDerivations(registry, frame) {
  return matchingBusinessRules(registry, frame, "derive")
    .map((rule) => ({
      code: `BUSINESS_RULE_DERIVE:${rule.id}`,
      filter: { ...rule.effect.derivedFilter, source: "policy" },
    }));
}

function hasSamePolicyFilter(filters, candidate) {
  return filters.some((filter) => filter.source === "policy"
    && filter.dimensionId === candidate.dimensionId
    && filter.operator === candidate.operator
    && canonicalJson(filter.values) === canonicalJson(candidate.values));
}

function applyDerivedFilters(frame, derivations) {
  const filters = [...(frame.filters || [])];
  for (const derivation of derivations) {
    if (!hasSamePolicyFilter(filters, derivation.filter)) {
      filters.push(derivation.filter);
    }
  }
  return derivations.length ? { ...frame, filters } : frame;
}

export function deriveBusinessRuleFrame({ registry, frame }) {
  const derivations = matchingBusinessRuleDerivations(registry, frame);
  return {
    frame: applyDerivedFilters(frame, derivations),
    derivationCodes: derivations.map((derivation) => derivation.code),
  };
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

function approvedTraceRelationshipPath(registry, frame) {
  if (frame.intent !== "trace") return [];
  if (typeof registry.getRelationship !== "function") throw new Error("SEMANTIC_UNSUPPORTED_JOIN:relationship_registry");
  const entityIds = new Set(frame.entityIds || []);
  const path = [];
  for (const { sourceEntity, targetEntity, relationshipId } of TRACE_LINEAGE_RELATIONSHIPS) {
    if (!entityIds.has(sourceEntity) || !entityIds.has(targetEntity)) continue;
    let relationship;
    try {
      relationship = registry.getRelationship(relationshipId);
    } catch {
      throw new Error(`SEMANTIC_UNSUPPORTED_JOIN:${sourceEntity}:${targetEntity}`);
    }
    const connectsEntities = (relationship.sourceEntity === sourceEntity && relationship.targetEntity === targetEntity)
      || (relationship.reversible === true && relationship.sourceEntity === targetEntity && relationship.targetEntity === sourceEntity);
    if (relationship.governance?.status !== "approved" || !connectsEntities) {
      throw new Error(`SEMANTIC_UNSUPPORTED_JOIN:${sourceEntity}:${targetEntity}`);
    }
    path.push(relationship);
  }
  const unbounded = path.find((relationship) => relationship?.cardinality === "many_to_many" && !relationship?.explosionPolicy);
  if (unbounded) throw new Error(`SEMANTIC_UNBOUNDED_CARDINALITY:${unbounded.id}`);
  return path;
}

function traceRelationshipWarnings(registry, frame) {
  const path = approvedTraceRelationshipPath(registry, frame);
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
      const ruleEffects = matchingEnforcedBusinessRuleEffects(registry, frame);
      const businessRuleDenials = ruleEffects.filter((effect) => effect.kind === "deny").map((effect) => effect.code);
      const businessRuleRequirements = unique(matchingBusinessRuleRequirements(registry, frame));
      const { frame: executionFrame, derivationCodes } = deriveBusinessRuleFrame({ registry, frame });
      const warnings = unique([
        ...frame.assumptions,
        ...matchingBusinessRuleWarnings(registry, frame),
        ...derivationCodes,
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
        ruleEffects,
      };
      if (businessRuleDenials.length) {
        return completePlan({
          base,
          frame,
          actorScopeHash,
          status: "denied",
          steps: [],
          violations: businessRuleDenials,
        });
      }
      const clarificationViolations = unique([
        ...frame.ambiguities.map((item) => item.code),
        ...businessRuleRequirements,
      ]);
      if (clarificationViolations.length) {
        return completePlan({
          base,
          frame,
          actorScopeHash,
          status: "needs_clarification",
          steps: [],
          violations: clarificationViolations,
        });
      }
      const metricConstraint = registry.getConstraint("planner.approved_metric_only");
      for (const metricId of executionFrame.metricIds) {
        const metric = registry.getMetric(metricId, { approvedOnly: metricConstraint.parameters.enabled !== false });
        const allowedDimensions = new Set(metric.allowedDimensions || []);
        const requestedDimensions = unique([
          ...executionFrame.dimensionIds,
          ...executionFrame.filters.map((item) => item.dimensionId),
          ...executionFrame.timeScopes.map((item) => item.fieldId),
        ]);
        for (const dimensionId of requestedDimensions) {
          if (!allowedDimensions.has(dimensionId)) {
            throw new Error(`SEMANTIC_DIMENSION_NOT_ALLOWED:${metric.id}:${dimensionId}`);
          }
        }
        const presentFilters = new Set(executionFrame.filters.filter((item) => Array.isArray(item.values) && item.values.length).map((item) => item.dimensionId));
        for (const requiredFilter of metric.requiredFilters || []) {
          if (!presentFilters.has(requiredFilter)) throw new Error(`SEMANTIC_METRIC_REQUIRED_FILTER_MISSING:${metric.id}:${requiredFilter}`);
        }
      }
      const maximumLimit = registry.getConstraint("query.max_limit").parameters.maximum;
      if (executionFrame.limit > maximumLimit) throw new Error(`QUERY_LIMIT_EXCEEDED:${maximumLimit}`);

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
        canonicalArgs = { query: compileSemanticQuery(executionFrame) };
      } else if (["list", "drilldown"].includes(frame.intent)) {
        operation = "semantic_record_query";
        toolName = "query_semantic_records";
        const entityId = frame.entityIds[0];
        canonicalArgs = {
          ontology_version: executionFrame.ontologyVersion,
          schema_fingerprint: executionFrame.schemaFingerprint,
          query: compileSemanticQuery(executionFrame),
          analysis_ref: null,
          selections: [],
          fields: defaultRecordFieldsForEntity(entityId),
          page: 1,
          page_size: Math.min(50, frame.limit),
        };
      } else {
        canonicalArgs = { query: compileSemanticQuery(executionFrame) };
      }
      const capability = registry.getPolicy("analytics.read_only");
      if (!capability.allowedOperations.includes(operation)) throw new Error(`PLAN_OPERATION_DENIED:${operation}`);
      const metricSlices = operation === "semantic_metric_query" && executionFrame.metricIds.length > 1
        ? executionFrame.metricIds.map((metricId) => [metricId])
        : [executionFrame.metricIds];
      const steps = metricSlices.map((metricIds, index) => ({
        stepId: `s${index + 1}`,
        operation,
        toolName,
        metricIds,
        dimensionIds: executionFrame.dimensionIds,
        canonicalArgs: operation === "semantic_metric_query"
          ? { query: compileSemanticQuery({ ...executionFrame, metricIds }) }
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
