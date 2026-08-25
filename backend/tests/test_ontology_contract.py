from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.analytics.ontology import OntologyLoadError, load_ontology, ontology_fingerprint
from backend.analytics.semantic_runtime import RUNTIME_ADAPTERS


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_python_loader_verifies_the_node_compiled_fingerprint() -> None:
    catalog = load_ontology(root=REPO_ROOT)

    assert catalog.version == "v1"
    assert catalog.fingerprint == (REPO_ROOT / "ontology/generated/fingerprint.txt").read_text(encoding="utf-8").strip()
    assert catalog.get_metric("defect.count", approved_only=True)["entityId"] == "quality.defect"
    assert catalog.get_policy("actor.scope.mandatory")["kind"] == "mandatory_scope"
    assert catalog.get_constraint("query.max_limit")["parameters"]["maximum"] == 200
    assert catalog.get_action("octane.defect.add_comment")["targetEntityId"] == "quality.defect"
    assert catalog.get_metric("defect.count", approved_only=True, runtime_ready_only=True)["runtime"] == {
        "status": "ready",
        "adapterId": "python.semantic.defects",
        "adapterVersion": "1.0.0",
    }


def test_python_and_node_canonical_fingerprint_contract_is_stable() -> None:
    bundle = json.loads((REPO_ROOT / "ontology/generated/ontology.compiled.json").read_text(encoding="utf-8"))
    assert ontology_fingerprint(bundle) == (REPO_ROOT / "ontology/generated/fingerprint.txt").read_text(encoding="utf-8").strip()


def test_machine_readable_runtime_report_matches_python_adapter_capabilities() -> None:
    report = json.loads((REPO_ROOT / "ontology/generated/runtime-capabilities.json").read_text(encoding="utf-8"))
    catalog = load_ontology(root=REPO_ROOT)
    ready_metrics = {
        metric["id"]
        for metric in catalog.bundle["metrics"]
        if metric["runtime"]["status"] == "ready"
    }

    assert report["ontologyFingerprint"] == catalog.fingerprint
    assert report["summary"] == {
        "approvedMetricCount": 17,
        "runtimeReadyMetricCount": 9,
        "approvedPlannedMetricCount": 8,
    }
    assert set(report["runtimeReadyMetricIds"]) == ready_metrics
    assert ready_metrics == {
        metric_id
        for adapter in RUNTIME_ADAPTERS.values()
        for metric_id in adapter["metric_ids"]
    }
    report_adapters = {item["adapterId"]: item for item in report["adapters"]}
    assert set(report_adapters) == set(RUNTIME_ADAPTERS)
    for adapter_id, adapter in RUNTIME_ADAPTERS.items():
        assert report_adapters[adapter_id]["adapterVersion"] == adapter["version"]
        assert set(report_adapters[adapter_id]["metricIds"]) == set(adapter["metric_ids"])
        assert report_adapters[adapter_id]["dimensionBindings"] == adapter["dimension_fields"]


def test_loader_fails_closed_when_compiled_content_is_modified(tmp_path: Path) -> None:
    source_bundle = json.loads((REPO_ROOT / "ontology/generated/ontology.compiled.json").read_text(encoding="utf-8"))
    source_bundle["metrics"][0]["description"] = "tampered"
    compiled_path = tmp_path / "ontology.compiled.json"
    fingerprint_path = tmp_path / "fingerprint.txt"
    compiled_path.write_text(json.dumps(source_bundle, ensure_ascii=False), encoding="utf-8")
    fingerprint_path.write_text((REPO_ROOT / "ontology/generated/fingerprint.txt").read_text(encoding="utf-8"), encoding="utf-8")

    with pytest.raises(OntologyLoadError, match="ONTOLOGY_FINGERPRINT_MISMATCH"):
        load_ontology(compiled_path=compiled_path, fingerprint_path=fingerprint_path)


def test_draft_metric_is_not_available_as_approved() -> None:
    catalog = load_ontology(root=REPO_ROOT)
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_METRIC_NOT_APPROVED"):
        catalog.get_metric("quality.defect_density", approved_only=True)


def test_approved_planned_metric_is_not_available_as_runtime_ready() -> None:
    catalog = load_ontology(root=REPO_ROOT)
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_METRIC_NOT_RUNTIME_READY:kpi.defect_detection_ratio"):
        catalog.get_metric("kpi.defect_detection_ratio", approved_only=True, runtime_ready_only=True)


def test_draft_or_blocked_action_is_not_available_as_approved() -> None:
    catalog = load_ontology(root=REPO_ROOT)
    assert catalog.get_action("octane.defect.update_triage_fields")["execution"]["mode"] == "disabled"
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_ACTION_NOT_APPROVED"):
        catalog.get_action("octane.defect.add_comment", approved_only=True)
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_ACTION_NOT_APPROVED"):
        catalog.get_action("octane.defect.delete_work_item", approved_only=True)


def test_unknown_policy_and_constraint_fail_closed() -> None:
    catalog = load_ontology(root=REPO_ROOT)
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_POLICY_NOT_APPROVED"):
        catalog.get_policy("missing.policy")
    with pytest.raises(OntologyLoadError, match="ONTOLOGY_CONSTRAINT_NOT_APPROVED"):
        catalog.get_constraint("missing.constraint")
