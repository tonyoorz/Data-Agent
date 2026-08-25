const adapter = (version, metricIds, dimensionBindings) => Object.freeze({
  version,
  metricIds: Object.freeze([...metricIds]),
  dimensionBindings: Object.freeze({ ...dimensionBindings }),
});

export const SEMANTIC_RUNTIME_ADAPTERS = Object.freeze({
  "python.semantic.defects": adapter(
    "1.0.0",
    ["defect.count", "defect.created_count", "defect.severe_count", "team.defect_discovery_count"],
    {
      "time.defect_creation_date": "creation_time",
      "org.problem_finder_team": "problem_finder_team",
      "product.project": "project",
      "product.service_pack": "service_pack",
      "product.pu": "pu",
      "product.i_step": "i_step",
      "product.os": "os",
      "product.platform": "platform",
      "product.ecu": "assigned_ecu",
      "vehicle.model_series": "model_series",
      "requirements.aida": "aida",
      "quality.phase": "phase",
      "quality.severity": "problem_severity",
      "quality.business_impact": "problem_severity",
      "quality.reporting_class": "classification",
      "quality.status": "status",
      "quality.china_scope": "china_scope",
    },
  ),
  "python.semantic.test_runs": adapter(
    "1.0.0",
    ["testing.run_count", "testing.passed_run_count", "testing.failed_run_count", "team.execution_count"],
    {
      "time.test_finished_date": "finished",
      "org.tester": "tester",
      "org.team": "team",
      "product.project": "project",
      "product.pu": "pu",
      "requirements.aida": "aida",
      "testing.run_status": "status",
      "time.test_week": "test_week",
    },
  ),
  "python.semantic.testcases": adapter(
    "1.0.0",
    ["testing.testcase_count"],
    {
      "product.project": "project",
      "product.pu": "pu",
      "requirements.aida": "aida",
    },
  ),
});

export function semanticMetricNotRuntimeReadyCode(metricId) {
  return `SEMANTIC_METRIC_NOT_RUNTIME_READY:${String(metricId || "unknown")}`;
}

export function validateMetricRuntimePublication(metric) {
  const metricId = String(metric?.id || "unknown");
  const publication = metric?.runtime;
  if (!publication || !["ready", "planned"].includes(publication.status)) {
    throw new Error(`ONTOLOGY_METRIC_RUNTIME_STATUS_INVALID:${metricId}`);
  }
  if (publication.status !== "ready") {
    return { ready: false, violation: semanticMetricNotRuntimeReadyCode(metricId), adapter: null };
  }
  const adapterId = String(publication.adapterId || "");
  const runtimeAdapter = SEMANTIC_RUNTIME_ADAPTERS[adapterId];
  if (!runtimeAdapter || runtimeAdapter.version !== publication.adapterVersion) {
    throw new Error(`ONTOLOGY_RUNTIME_ADAPTER_NOT_FOUND:${metricId}:${adapterId}@${publication.adapterVersion || "missing"}`);
  }
  if (!runtimeAdapter.metricIds.includes(metricId)) {
    throw new Error(`ONTOLOGY_RUNTIME_METRIC_NOT_BOUND:${metricId}:${adapterId}`);
  }
  for (const dimensionId of metric.allowedDimensions || []) {
    if (!Object.hasOwn(runtimeAdapter.dimensionBindings, dimensionId)) {
      throw new Error(`ONTOLOGY_RUNTIME_DIMENSION_NOT_SUPPORTED:${metricId}:${dimensionId}`);
    }
  }
  return { ready: true, violation: null, adapter: runtimeAdapter };
}

export function buildRuntimeCapabilityReport(bundle, ontologyFingerprint) {
  const metrics = [...(bundle?.metrics || [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((metric) => ({
      metricId: metric.id,
      governanceStatus: metric.governance?.status || "unknown",
      runtimeStatus: metric.runtime?.status || "unknown",
      ...(metric.runtime?.adapterId ? { adapterId: metric.runtime.adapterId, adapterVersion: metric.runtime.adapterVersion } : {}),
      allowedDimensions: [...(metric.allowedDimensions || [])],
    }));
  return {
    schemaVersion: "1.0",
    ontologyVersion: bundle?.ontologyVersion || "unknown",
    ontologyFingerprint,
    summary: {
      approvedMetricCount: metrics.filter((metric) => metric.governanceStatus === "approved").length,
      runtimeReadyMetricCount: metrics.filter((metric) => metric.runtimeStatus === "ready").length,
      approvedPlannedMetricCount: metrics.filter((metric) => metric.governanceStatus === "approved" && metric.runtimeStatus === "planned").length,
    },
    runtimeReadyMetricIds: metrics.filter((metric) => metric.runtimeStatus === "ready").map((metric) => metric.metricId),
    approvedPlannedMetricIds: metrics.filter((metric) => metric.governanceStatus === "approved" && metric.runtimeStatus === "planned").map((metric) => metric.metricId),
    adapters: Object.entries(SEMANTIC_RUNTIME_ADAPTERS).map(([adapterId, value]) => ({
      adapterId,
      adapterVersion: value.version,
      metricIds: [...value.metricIds],
      dimensionBindings: { ...value.dimensionBindings },
    })),
    metrics,
  };
}
