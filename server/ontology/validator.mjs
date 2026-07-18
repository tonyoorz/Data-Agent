function fail(code, details = "") {
  throw new Error(details ? `${code}:${details}` : code);
}

function uniqueById(items, type) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail("ONTOLOGY_DUPLICATE_ID", `${type}:${item.id}`);
    seen.add(item.id);
  }
  return seen;
}

function governanceStatus(item) {
  return item?.governance?.status;
}

export function validateOntologyBundle(bundle) {
  if (bundle?.schemaVersion !== "1.0" || bundle?.ontologyVersion !== "v1") {
    fail("ONTOLOGY_VERSION_INVALID");
  }
  const sources = bundle.sources || [];
  const entities = bundle.entities || [];
  const relationships = bundle.relationships || [];
  const dimensions = bundle.dimensions || [];
  const metrics = bundle.metrics || [];
  const terms = bundle.terms || [];
  const policies = bundle.policies || [];
  const constraints = bundle.constraints || [];
  const sourceIds = uniqueById(sources, "source");
  const entityIds = uniqueById(entities, "entity");
  uniqueById(relationships, "relationship");
  const dimensionIds = uniqueById(dimensions, "dimension");
  const metricIds = uniqueById(metrics, "metric");
  uniqueById(terms, "term");
  uniqueById(policies, "policy");
  uniqueById(constraints, "constraint");

  const sourceById = new Map(sources.map((item) => [item.id, item]));
  const sourceByReadModel = new Map(sources.map((item) => [item.readModel, item]));
  const entityById = new Map(entities.map((item) => [item.id, item]));
  const dimensionById = new Map(dimensions.map((item) => [item.id, item]));
  const metricById = new Map(metrics.map((item) => [item.id, item]));

  for (const entity of entities) {
    if (!sourceIds.has(entity.source?.sourceId)) fail("ONTOLOGY_SOURCE_NOT_FOUND", `${entity.id}:${entity.source?.sourceId}`);
    const source = sourceById.get(entity.source.sourceId);
    if (source.readModel !== entity.source.readModel) fail("ONTOLOGY_READ_MODEL_MISMATCH", entity.id);
    const properties = entity.properties.map((property) => property.id);
    if (new Set(properties).size !== properties.length) fail("ONTOLOGY_DUPLICATE_PROPERTY", entity.id);
    if (!properties.includes(entity.primaryKey)) fail("ONTOLOGY_PRIMARY_KEY_NOT_FOUND", entity.id);
  }

  for (const source of sources) {
    if (source.system !== "artifact" && (!Number.isInteger(source.freshnessSloMinutes) || source.freshnessSloMinutes < 1)) {
      fail("ONTOLOGY_SOURCE_FRESHNESS_SLO_REQUIRED", source.id);
    }
  }

  for (const relationship of relationships) {
    if (!entityIds.has(relationship.sourceEntity)) fail("ONTOLOGY_RELATION_SOURCE_NOT_FOUND", relationship.id);
    if (!entityIds.has(relationship.targetEntity)) fail("ONTOLOGY_RELATION_TARGET_NOT_FOUND", relationship.id);
    if (relationship.cardinality === "many_to_many" && !relationship.explosionPolicy) {
      fail("ONTOLOGY_MANY_TO_MANY_POLICY_REQUIRED", relationship.id);
    }
    for (const path of relationship.allowedJoinPaths) {
      if (path[0] !== relationship.sourceEntity || path.at(-1) !== relationship.targetEntity) {
        fail("ONTOLOGY_JOIN_PATH_ENDPOINT_MISMATCH", relationship.id);
      }
      if (relationship.sourceEntity !== relationship.targetEntity && new Set(path).size !== path.length) {
        fail("ONTOLOGY_JOIN_PATH_CYCLE", relationship.id);
      }
      for (const entityId of path) {
        if (!entityIds.has(entityId)) fail("ONTOLOGY_JOIN_PATH_ENTITY_NOT_FOUND", `${relationship.id}:${entityId}`);
      }
    }
  }

  for (const dimension of dimensions) {
    const entity = entityById.get(dimension.entityId);
    if (!entity) fail("ONTOLOGY_DIMENSION_ENTITY_NOT_FOUND", dimension.id);
    if (!entity.properties.some((property) => property.id === dimension.propertyId)) {
      fail("ONTOLOGY_DIMENSION_PROPERTY_NOT_FOUND", dimension.id);
    }
    if (!sourceByReadModel.has(dimension.sourceReadModel)) fail("ONTOLOGY_DIMENSION_SOURCE_NOT_FOUND", dimension.id);
  }

  for (const metric of metrics) {
    const entity = entityById.get(metric.entityId);
    if (!entity) fail("ONTOLOGY_METRIC_ENTITY_NOT_FOUND", metric.id);
    if (metric.defaultTimeDimension && !dimensionIds.has(metric.defaultTimeDimension)) {
      fail("ONTOLOGY_METRIC_TIME_DIMENSION_NOT_FOUND", metric.id);
    }
    for (const dimensionId of metric.allowedDimensions) {
      if (!dimensionIds.has(dimensionId)) fail("ONTOLOGY_METRIC_DIMENSION_NOT_FOUND", `${metric.id}:${dimensionId}`);
    }
    if (metric.defaultTimeDimension && !metric.allowedDimensions.includes(metric.defaultTimeDimension)) {
      fail("ONTOLOGY_METRIC_DEFAULT_TIME_NOT_ALLOWED", metric.id);
    }
    for (const requiredFilter of metric.requiredFilters) {
      if (!metric.allowedDimensions.includes(requiredFilter)) fail("ONTOLOGY_METRIC_REQUIRED_FILTER_NOT_ALLOWED", `${metric.id}:${requiredFilter}`);
    }
    const source = sourceByReadModel.get(metric.sourceReadModel);
    if (!source) fail("ONTOLOGY_METRIC_SOURCE_NOT_FOUND", metric.id);
    if (governanceStatus(metric) === "approved") {
      if (governanceStatus(entity) !== "approved") fail("ONTOLOGY_APPROVED_METRIC_USES_UNAPPROVED_ENTITY", metric.id);
      if (governanceStatus(source) !== "approved") fail("ONTOLOGY_APPROVED_METRIC_USES_UNAPPROVED_SOURCE", metric.id);
      for (const dimensionId of metric.allowedDimensions) {
        if (governanceStatus(dimensionById.get(dimensionId)) !== "approved") {
          fail("ONTOLOGY_APPROVED_METRIC_USES_UNAPPROVED_DIMENSION", `${metric.id}:${dimensionId}`);
        }
      }
    }
  }

  for (const term of terms) {
    const resolution = term.resolution || {};
    if (resolution.entityId && !entityIds.has(resolution.entityId)) fail("ONTOLOGY_TERM_ENTITY_NOT_FOUND", term.id);
    if (resolution.dimensionId && !dimensionIds.has(resolution.dimensionId)) fail("ONTOLOGY_TERM_DIMENSION_NOT_FOUND", term.id);
    if (resolution.metricId && !metricIds.has(resolution.metricId)) fail("ONTOLOGY_TERM_METRIC_NOT_FOUND", term.id);
    if (governanceStatus(term) === "approved" && resolution.metricId && governanceStatus(metricById.get(resolution.metricId)) !== "approved") {
      fail("ONTOLOGY_APPROVED_TERM_USES_UNAPPROVED_METRIC", term.id);
    }
    if (term.kind === "value_pattern") {
      if (!resolution.dimensionId || !resolution.valuePattern || resolution.filterValue !== undefined) {
        fail("ONTOLOGY_VALUE_PATTERN_INVALID", term.id);
      }
      let pattern;
      try {
        pattern = new RegExp(resolution.valuePattern, "iu");
      } catch {
        fail("ONTOLOGY_VALUE_PATTERN_INVALID", term.id);
      }
      if (pattern.test("")) fail("ONTOLOGY_VALUE_PATTERN_EMPTY_MATCH", term.id);
    } else if (resolution.valuePattern) {
      fail("ONTOLOGY_VALUE_PATTERN_KIND_REQUIRED", term.id);
    }
  }

  for (const policy of policies) {
    if (governanceStatus(policy) === "approved" && !policy.allowedOperations.length) fail("ONTOLOGY_POLICY_OPERATION_REQUIRED", policy.id);
    for (const rule of policy.rules || []) {
      if (!entityIds.has(rule.entityId)) fail("ONTOLOGY_POLICY_ENTITY_NOT_FOUND", `${policy.id}:${rule.entityId}`);
      if (!dimensionIds.has(rule.dimensionId)) fail("ONTOLOGY_POLICY_DIMENSION_NOT_FOUND", `${policy.id}:${rule.dimensionId}`);
      if (dimensionById.get(rule.dimensionId)?.entityId !== rule.entityId && rule.dimensionId !== "product.project") {
        fail("ONTOLOGY_POLICY_DIMENSION_ENTITY_MISMATCH", `${policy.id}:${rule.dimensionId}`);
      }
    }
  }

  for (const constraint of constraints) {
    for (const metricId of constraint.metricIds || []) if (!metricIds.has(metricId)) fail("ONTOLOGY_CONSTRAINT_METRIC_NOT_FOUND", `${constraint.id}:${metricId}`);
    for (const dimensionId of constraint.dimensionIds || []) if (!dimensionIds.has(dimensionId)) fail("ONTOLOGY_CONSTRAINT_DIMENSION_NOT_FOUND", `${constraint.id}:${dimensionId}`);
    const relationshipIds = new Set(relationships.map((item) => item.id));
    for (const relationshipId of constraint.relationshipIds || []) if (!relationshipIds.has(relationshipId)) fail("ONTOLOGY_CONSTRAINT_RELATIONSHIP_NOT_FOUND", `${constraint.id}:${relationshipId}`);
    if (constraint.kind === "query_limit" && (!Number.isInteger(constraint.parameters?.maximum) || constraint.parameters.maximum < 1)) {
      fail("ONTOLOGY_QUERY_LIMIT_INVALID", constraint.id);
    }
  }

  return Object.freeze({
    sourceCount: sources.length,
    entityCount: entities.length,
    relationshipCount: relationships.length,
    dimensionCount: dimensions.length,
    metricCount: metrics.length,
    termCount: terms.length,
    policyCount: policies.length,
    constraintCount: constraints.length,
  });
}
