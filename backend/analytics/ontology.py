from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from backend.analytics.semantic_runtime import (
    RuntimePublicationError,
    validate_metric_runtime_publication,
    validate_runtime_publication,
)


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

    def get_metric(
        self,
        metric_id: str,
        *,
        approved_only: bool = False,
        runtime_ready_only: bool = False,
    ) -> dict[str, Any]:
        metric = next((item for item in self.bundle["metrics"] if item["id"] == metric_id), None)
        if metric is None:
            raise OntologyLoadError(f"ONTOLOGY_METRIC_NOT_FOUND:{metric_id}")
        if approved_only and metric["governance"]["status"] != "approved":
            raise OntologyLoadError(f"ONTOLOGY_METRIC_NOT_APPROVED:{metric_id}")
        if runtime_ready_only:
            try:
                validate_metric_runtime_publication(metric)
            except RuntimePublicationError as exc:
                raise OntologyLoadError(str(exc)) from exc
        return metric

    def get_dimension(self, dimension_id: str) -> dict[str, Any]:
        dimension = next((item for item in self.bundle["dimensions"] if item["id"] == dimension_id), None)
        if dimension is None:
            raise OntologyLoadError(f"ONTOLOGY_DIMENSION_NOT_FOUND:{dimension_id}")
        return dimension

    def find_relationship_path(
        self,
        source_entity: str,
        target_entity: str,
        *,
        approved_only: bool = True,
        max_depth: int = 6,
    ) -> list[dict[str, Any]]:
        source = str(source_entity or "")
        target = str(target_entity or "")
        if not source or not target or source == target:
            return []
        edges: list[tuple[str, str, dict[str, Any]]] = []
        for relationship in sorted(self.bundle.get("relationships", []), key=lambda item: str(item.get("id") or "")):
            if approved_only and relationship.get("governance", {}).get("status") != "approved":
                continue
            source_id = str(relationship.get("sourceEntity") or "")
            target_id = str(relationship.get("targetEntity") or "")
            if not source_id or not target_id:
                continue
            edges.append((source_id, target_id, relationship))
            if relationship.get("reversible"):
                edges.append((target_id, source_id, relationship))
        queue: list[tuple[str, list[dict[str, Any]]]] = [(source, [])]
        visited = {source}
        while queue:
            current, path = queue.pop(0)
            if len(path) >= max_depth:
                continue
            for edge_source, edge_target, relationship in edges:
                if edge_source != current or edge_target in visited:
                    continue
                next_path = [*path, relationship]
                if edge_target == target:
                    return next_path
                visited.add(edge_target)
                queue.append((edge_target, next_path))
        return []

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

    def list_business_rules(self, *, kind: str | None = None, approved_only: bool = True) -> list[dict[str, Any]]:
        return [
            rule
            for rule in self.bundle.get("businessRules", [])
            if (not approved_only or rule.get("governance", {}).get("status") == "approved")
            and (kind is None or rule.get("kind") == kind)
        ]

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
    try:
        validate_runtime_publication(bundle)
    except RuntimePublicationError as exc:
        raise OntologyLoadError(str(exc)) from exc

    computed = ontology_fingerprint(bundle)
    declared_value = declared.read_text(encoding="utf-8").strip()
    if computed != declared_value:
        raise OntologyLoadError("ONTOLOGY_FINGERPRINT_MISMATCH")
    required = expected_fingerprint or os.environ.get("VIZION_ONTOLOGY_FINGERPRINT")
    if required and computed != required:
        raise OntologyLoadError("ONTOLOGY_EXPECTED_FINGERPRINT_MISMATCH")
    return OntologyCatalog(version=bundle["ontologyVersion"], fingerprint=computed, bundle=bundle)
