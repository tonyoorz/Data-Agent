function unique(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeTeamId(value) {
  return /^DTSV(?:_China)?$/i.test(String(value)) ? "DTSV_China" : String(value);
}

export function mandatoryScopeFilters(actor, entityIds, intent, registry) {
  const scopes = actor?.scopes || {};
  const policy = registry.getPolicy("actor.scope.mandatory");
  const filters = [];
  for (const rule of policy.rules) {
    if (!entityIds.includes(rule.entityId) || !rule.intents.includes(intent)) continue;
    let values = unique(scopes[rule.scopeKey]);
    if (rule.scopeKey === "teamIds" && !values.length) continue;
    if (rule.scopeKey === "workspaceIds" && unique(scopes.teamIds).length) continue;
    if (rule.normalizer === "dtsv_team") {
      values = values.map(normalizeTeamId);
      if (rule.scopeKey === "workspaceIds") values = values.filter((value) => value === "DTSV_China");
    }
    if (!values.length) continue;
    filters.push({ dimensionId: rule.dimensionId, operator: "in", values, source: "policy" });
  }
  return filters;
}

function objectTypeAliases(entityId) {
  const tail = String(entityId).split(".").at(-1);
  return new Set([String(entityId), tail, tail?.replaceAll("_", "-")]);
}

export function assertOntologyScopeAccess({ actor, frame, registry }) {
  const scopes = actor?.scopes || {};
  if (Object.hasOwn(scopes, "allowedObjectTypes")) {
    const allowed = new Set(unique(scopes.allowedObjectTypes));
    if (!allowed.size) throw new Error("SEMANTIC_OBJECT_SCOPE_EMPTY");
    for (const entityId of frame.entityIds) {
      if (![...objectTypeAliases(entityId)].some((alias) => allowed.has(alias))) {
        throw new Error(`SEMANTIC_OBJECT_SCOPE_DENIED:${entityId}`);
      }
    }
  }

  const allowedProperties = new Set(unique(scopes.allowedPropertyIds));
  const sensitivePolicies = new Set(unique(scopes.sensitiveFieldPolicyIds));
  const dimensionIds = new Set([
    ...frame.dimensionIds,
    ...frame.filters.map((item) => item.dimensionId),
    ...frame.timeScopes.map((item) => item.fieldId),
    ...frame.sort.map((item) => item.fieldId).filter((id) => !frame.metricIds.includes(id)),
  ]);
  for (const dimensionId of dimensionIds) {
    const dimension = registry.getDimension(dimensionId);
    const entity = registry.getEntity(dimension.entityId);
    const property = entity.properties.find((item) => item.id === dimension.propertyId);
    if (!property || !["confidential", "restricted"].includes(property.sensitivity)) continue;
    const propertyRefs = [dimensionId, property.id, `${entity.id}.${property.id}`];
    const allowed = propertyRefs.some((ref) => allowedProperties.has(ref))
      && (sensitivePolicies.has("pseudonymize:confidential") || sensitivePolicies.has(`pseudonymize:${dimensionId}`) || sensitivePolicies.has("raw:confidential"));
    if (!allowed) throw new Error(`SEMANTIC_SENSITIVE_FIELD_DENIED:${dimensionId}`);
  }

  const mandatory = mandatoryScopeFilters(actor, frame.entityIds, frame.intent, registry);
  for (const required of mandatory) {
    const policyFilters = frame.filters.filter((item) => item.source === "policy" && item.dimensionId === required.dimensionId);
    const present = new Set(policyFilters.flatMap((item) => item.values).map(String));
    if (required.values.some((value) => !present.has(String(value)))) {
      throw new Error(`SEMANTIC_POLICY_FILTER_REQUIRED:${required.dimensionId}`);
    }
    const allowedValues = new Set(required.values.map(String));
    for (const item of frame.filters.filter((filter) => filter.dimensionId === required.dimensionId)) {
      if (item.values.some((value) => !allowedValues.has(String(value)))) throw new Error("SEMANTIC_SCOPE_FILTER_DENIED");
    }
  }
}
