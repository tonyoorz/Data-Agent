from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
from typing import Any


class OntologyLoadError(RuntimeError):
    """Raised when the compiled Ontology cannot be trusted."""


def _default_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def ontology_fingerprint(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class OntologyCatalog:
    version: str
    fingerprint: str
    bundle: dict[str, Any]

    def get_metric(self, metric_id: str, *, approved_only: bool = False) -> dict[str, Any]:
        metric = next((item for item in self.bundle["metrics"] if item["id"] == metric_id), None)
        if metric is None:
            raise OntologyLoadError(f"ONTOLOGY_METRIC_NOT_FOUND:{metric_id}")
        if approved_only and metric["governance"]["status"] != "approved":
            raise OntologyLoadError(f"ONTOLOGY_METRIC_NOT_APPROVED:{metric_id}")
        return metric

    def get_dimension(self, dimension_id: str) -> dict[str, Any]:
        dimension = next((item for item in self.bundle["dimensions"] if item["id"] == dimension_id), None)
        if dimension is None:
            raise OntologyLoadError(f"ONTOLOGY_DIMENSION_NOT_FOUND:{dimension_id}")
        return dimension

    def get_policy(self, policy_id: str) -> dict[str, Any]:
        policy = next((item for item in self.bundle["policies"] if item["id"] == policy_id), None)
        if policy is None or policy["governance"]["status"] != "approved":
            raise OntologyLoadError(f"ONTOLOGY_POLICY_NOT_APPROVED:{policy_id}")
        return policy

    def get_constraint(self, constraint_id: str) -> dict[str, Any]:
        constraint = next((item for item in self.bundle["constraints"] if item["id"] == constraint_id), None)
        if constraint is None or constraint["governance"]["status"] != "approved":
            raise OntologyLoadError(f"ONTOLOGY_CONSTRAINT_NOT_APPROVED:{constraint_id}")
        return constraint

    def get_action(self, action_id: str, *, approved_only: bool = False) -> dict[str, Any]:
        action = next((item for item in self.bundle.get("actions", []) if item["id"] == action_id), None)
        if action is None:
            raise OntologyLoadError(f"ONTOLOGY_ACTION_NOT_FOUND:{action_id}")
        if approved_only and (action["governance"]["status"] != "approved" or action["execution"]["mode"] != "enabled"):
            raise OntologyLoadError(f"ONTOLOGY_ACTION_NOT_APPROVED:{action_id}")
        return action


def load_ontology(
    *,
    root: Path | str | None = None,
    compiled_path: Path | str | None = None,
    fingerprint_path: Path | str | None = None,
    expected_fingerprint: str | None = None,
) -> OntologyCatalog:
    ontology_root = Path(root or os.environ.get("VIZION_ONTOLOGY_ROOT") or _default_root())
    compiled = Path(compiled_path or ontology_root / "ontology" / "generated" / "ontology.compiled.json")
    declared = Path(fingerprint_path or ontology_root / "ontology" / "generated" / "fingerprint.txt")
    if not compiled.is_file() or not declared.is_file():
        raise OntologyLoadError("ONTOLOGY_NOT_COMPILED")

    try:
        bundle = json.loads(compiled.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OntologyLoadError(f"ONTOLOGY_COMPILED_JSON_INVALID:{exc}") from exc
    if bundle.get("schemaVersion") != "1.0" or bundle.get("ontologyVersion") != "v1":
        raise OntologyLoadError("ONTOLOGY_VERSION_INVALID")

    computed = ontology_fingerprint(bundle)
    declared_value = declared.read_text(encoding="utf-8").strip()
    if computed != declared_value:
        raise OntologyLoadError("ONTOLOGY_FINGERPRINT_MISMATCH")
    required = expected_fingerprint or os.environ.get("VIZION_ONTOLOGY_FINGERPRINT")
    if required and computed != required:
        raise OntologyLoadError("ONTOLOGY_EXPECTED_FINGERPRINT_MISMATCH")
    return OntologyCatalog(version=bundle["ontologyVersion"], fingerprint=computed, bundle=bundle)
