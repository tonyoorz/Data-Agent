from __future__ import annotations

from typing import Any


class RuntimePublicationError(ValueError):
    pass


RUNTIME_ADAPTERS: dict[str, dict[str, Any]] = {
    "python.semantic.defects": {
        "version": "1.0.0",
        "metric_ids": frozenset({"defect.count", "defect.created_count", "defect.severe_count", "team.defect_discovery_count"}),
        "dimension_fields": {
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
    },
    "python.semantic.test_runs": {
        "version": "1.0.0",
        "metric_ids": frozenset({"testing.run_count", "testing.passed_run_count", "testing.failed_run_count", "team.execution_count"}),
        "dimension_fields": {
            "time.test_finished_date": "finished",
            "org.tester": "tester",
            "org.team": "team",
            "product.project": "project",
            "product.pu": "pu",
            "requirements.aida": "aida",
            "testing.run_status": "status",
            "time.test_week": "test_week",
        },
    },
    "python.semantic.testcases": {
        "version": "1.0.0",
        "metric_ids": frozenset({"testing.testcase_count"}),
        "dimension_fields": {
            "product.project": "project",
            "product.pu": "pu",
            "requirements.aida": "aida",
        },
    },
}


def validate_metric_runtime_publication(metric: dict[str, Any]) -> dict[str, Any]:
    metric_id = str(metric.get("id") or "unknown")
    publication = metric.get("runtime")
    if not isinstance(publication, dict) or publication.get("status") not in {"ready", "planned"}:
        raise RuntimePublicationError(f"ONTOLOGY_METRIC_RUNTIME_STATUS_INVALID:{metric_id}")
    if publication["status"] != "ready":
        raise RuntimePublicationError(f"ONTOLOGY_METRIC_NOT_RUNTIME_READY:{metric_id}")
    adapter_id = str(publication.get("adapterId") or "")
    adapter_version = str(publication.get("adapterVersion") or "")
    adapter = RUNTIME_ADAPTERS.get(adapter_id)
    if adapter is None or adapter["version"] != adapter_version:
        raise RuntimePublicationError(
            f"ONTOLOGY_RUNTIME_ADAPTER_NOT_FOUND:{metric_id}:{adapter_id}@{adapter_version or 'missing'}"
        )
    if metric_id not in adapter["metric_ids"]:
        raise RuntimePublicationError(f"ONTOLOGY_RUNTIME_METRIC_NOT_BOUND:{metric_id}:{adapter_id}")
    for dimension_id in metric.get("allowedDimensions", []):
        if dimension_id not in adapter["dimension_fields"]:
            raise RuntimePublicationError(f"ONTOLOGY_RUNTIME_DIMENSION_NOT_SUPPORTED:{metric_id}:{dimension_id}")
    return adapter


def validate_runtime_publication(bundle: dict[str, Any]) -> None:
    ready_metric_ids: set[str] = set()
    for metric in bundle.get("metrics", []):
        publication = metric.get("runtime")
        if not isinstance(publication, dict) or publication.get("status") not in {"ready", "planned"}:
            raise RuntimePublicationError(f"ONTOLOGY_METRIC_RUNTIME_STATUS_INVALID:{metric.get('id', 'unknown')}")
        if publication["status"] == "ready":
            validate_metric_runtime_publication(metric)
            ready_metric_ids.add(str(metric["id"]))
    expected_metric_ids = {
        metric_id
        for adapter in RUNTIME_ADAPTERS.values()
        for metric_id in adapter["metric_ids"]
    }
    if ready_metric_ids != expected_metric_ids:
        missing = sorted(expected_metric_ids - ready_metric_ids)
        extra = sorted(ready_metric_ids - expected_metric_ids)
        raise RuntimePublicationError(
            f"ONTOLOGY_RUNTIME_METRIC_PARITY_INVALID:missing={','.join(missing)}:extra={','.join(extra)}"
        )
