from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.analytics.ontology import OntologyLoadError, load_ontology, ontology_fingerprint


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_python_loader_verifies_the_node_compiled_fingerprint() -> None:
    catalog = load_ontology(root=REPO_ROOT)

    assert catalog.version == "v1"
    assert catalog.fingerprint == (REPO_ROOT / "ontology/generated/fingerprint.txt").read_text(encoding="utf-8").strip()
    assert catalog.get_metric("defect.count", approved_only=True)["entityId"] == "quality.defect"
    assert catalog.get_policy("actor.scope.mandatory")["kind"] == "mandatory_scope"
    assert catalog.get_constraint("query.max_limit")["parameters"]["maximum"] == 200
    assert catalog.get_action("octane.defect.add_comment")["targetEntityId"] == "quality.defect"


def test_python_and_node_canonical_fingerprint_contract_is_stable() -> None:
    bundle = json.loads((REPO_ROOT / "ontology/generated/ontology.compiled.json").read_text(encoding="utf-8"))
    assert ontology_fingerprint(bundle) == (REPO_ROOT / "ontology/generated/fingerprint.txt").read_text(encoding="utf-8").strip()


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
