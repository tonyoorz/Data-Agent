// Consumer-facing catalog of the governed semantic surface.
// Projects the ontology's approved metrics into a stable, frontend/Agent-friendly shape so
// callers can render "what can I currently ask" without coupling to internal governance fields.
// Pure function over the registry: deterministic, side-effect free, unit-testable.

export function buildApprovedMetricsCatalog(registry, { locale = "zh-CN" } = {}) {
  if (!registry) throw new Error("ONTOLOGY_REGISTRY_REQUIRED");
  const metrics = registry.listMetrics({ status: "approved" }).map((metric) => ({
    id: metric.id,
    label: metric.labels?.[locale] || metric.labels?.["en-US"] || metric.id,
    labels: metric.labels,
    description: metric.description,
    entity: metric.entityId,
    unit: metric.unit,
    grain: metric.grain,
    defaultTimeDimension: metric.defaultTimeDimension,
    allowedDimensions: metric.allowedDimensions || [],
    capabilities: metric.capabilities || {},
    owner: metric.governance?.owner,
  }));
  return Object.freeze({
    ontologyVersion: registry.version,
    ontologyFingerprint: registry.fingerprint,
    locale,
    count: metrics.length,
    metrics,
  });
}
