from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from typing import Any

import pytest

from backend.analytics.ontology import OntologyCatalog, load_ontology
from backend.analytics.semantic_analysis_store import SemanticAnalysisStore
from backend.analytics.semantic_query import SemanticQueryError, execute_semantic_query, execute_semantic_records


REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_PATH = REPO_ROOT / "evals" / "semantic-execution" / "target" / "semantic-execution-golden.jsonl"
GOLDEN_SNAPSHOT_ID = "semantic-execution-snapshot-v1"
GOLDEN_ROWS = [
    {
        "ticket_id": "D-G1",
        "ticket_name": "Audio golden",
        "problem_finder_team": "DTSV_China",
        "assigned_ecu": "HU",
        "os": "OS8",
        "project": "P1",
        "status": "Open",
        "creation_time": "2026-07-10T08:00:00Z",
    },
    {
        "ticket_id": "D-G2",
        "ticket_name": "Navigation golden",
        "problem_finder_team": "DTSV_China",
        "assigned_ecu": "HU",
        "os": "OS9",
        "project": "P1",
        "status": "Fixed",
        "creation_time": "2026-07-11T08:00:00Z",
    },
    {
        "ticket_id": "D-G3",
        "ticket_name": "Camera golden",
        "problem_finder_team": "DTSV_China",
        "assigned_ecu": "ADAS",
        "os": "OS9",
        "project": "P2",
        "status": "Open",
        "creation_time": "2026-06-15T08:00:00Z",
    },
    {
        "ticket_id": "D-G4",
        "ticket_name": "Out of scope golden",
        "problem_finder_team": "OTHER",
        "assigned_ecu": "HU",
        "os": "OS8",
        "project": "P3",
        "status": "Open",
        "creation_time": "2026-07-11T08:00:00Z",
    },
]


@pytest.fixture(scope="module")
def catalog() -> OntologyCatalog:
    return load_ontology(root=REPO_ROOT)


def _load_cases() -> list[dict[str, Any]]:
    return [json.loads(line) for line in GOLDEN_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]


def _actor_scope(scope_hash: str = "golden-scope-a") -> dict[str, Any]:
    return {
        "actorId": "golden-alice",
        "scopeHash": scope_hash,
        "workspaceIds": ["DTSV"],
        "projectIds": [],
        "teamIds": ["DTSV"],
        "allowedObjectTypes": ["quality.defect"],
        "allowedPropertyIds": [],
        "rowPolicyIds": ["dtsv"],
        "sensitiveFieldPolicyIds": [],
    }


def _query(catalog: OntologyCatalog, spec: dict[str, Any]) -> dict[str, Any]:
    query = {
        "schemaVersion": "1.0",
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "intent": "aggregate",
        "entityIds": ["quality.defect"],
        "metricIds": ["defect.count"],
        "dimensionIds": [],
        "filters": [{"dimensionId": "org.problem_finder_team", "operator": "in", "values": ["DTSV_China"], "source": "policy"}],
        "timeScopes": [],
        "comparison": None,
        "sort": [],
        "limit": 20,
    }
    query.update(deepcopy(spec))
    query["schemaVersion"] = "1.0"
    query["ontologyVersion"] = catalog.version
    query["schemaFingerprint"] = catalog.fingerprint
    return query


def _request(catalog: OntologyCatalog, query_spec: dict[str, Any], *, query_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "queryId": query_id,
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "query": _query(catalog, query_spec),
        "actorScope": _actor_scope(),
    }


def _defect_provider(rows: list[dict[str, Any]], *, snapshot_id: str = GOLDEN_SNAPSHOT_ID):
    def provider(_filters: dict[str, Any]) -> dict[str, Any]:
        return {
            "snapshot_version": snapshot_id,
            "generated_from": {},
            "ticket_rows": deepcopy(rows),
        }

    return provider


def _provider_rows(case: dict[str, Any]) -> list[dict[str, Any]]:
    if case.get("provider") == "empty":
        return []
    if case.get("provider") == "missing_ecu":
        return [{"ticket_id": "D-G-MISSING", "problem_finder_team": "DTSV_China", "assigned_ecu": ""}]
    return GOLDEN_ROWS


def _assert_query_result(result: dict[str, Any], expected: dict[str, Any]) -> None:
    assert result["data"] == expected["data"]
    assert result["summary"]["metrics"] == expected["metrics"]
    assert result["sourceRevision"]["revisionId"] == expected["sourceRevisionId"]
    assert result["analysisRef"].startswith("analysis-")
    assert result["evidence"]["kind"] == expected["evidenceKind"]


def _run_records_case(case: dict[str, Any], catalog: OntologyCatalog, store: SemanticAnalysisStore) -> None:
    aggregate = execute_semantic_query(
        _request(catalog, case["aggregateQuery"], query_id=f"{case['caseId']}-aggregate"),
        catalog=catalog,
        analysis_store=store,
        defect_provider=_defect_provider(GOLDEN_ROWS),
    )
    request = {
        "schemaVersion": "1.0",
        "queryId": case["caseId"],
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "query": None,
        "analysisRef": aggregate["analysisRef"],
        "actorScope": _actor_scope(case.get("scopeHash", "golden-scope-a")),
        "selections": case.get("selections", []),
        "fields": case["fields"],
        "page": 1,
        "pageSize": 20,
    }
    provider = _defect_provider(GOLDEN_ROWS, snapshot_id=case.get("recordsSnapshotId", GOLDEN_SNAPSHOT_ID))
    if "error" in case:
        with pytest.raises(SemanticQueryError, match=case["error"]["code"]) as exc_info:
            execute_semantic_records(request, catalog=catalog, analysis_store=store, defect_provider=provider)
        assert exc_info.value.status_code == case["error"]["statusCode"]
        return

    result = execute_semantic_records(request, catalog=catalog, analysis_store=store, defect_provider=provider)
    expected = case["expected"]
    assert result["analysisRef"] == aggregate["analysisRef"]
    assert result["sourceRevision"]["revisionId"] == GOLDEN_SNAPSHOT_ID
    assert result["evidence"]["kind"] == "semantic_record_set"
    assert result["data"] == expected["data"]
    assert result["pagination"]["totalRows"] == expected["totalRows"]


def _execute_case(case: dict[str, Any], catalog: OntologyCatalog, db_path: Path) -> None:
    store = SemanticAnalysisStore(db_path)
    kind = case["kind"]
    if kind == "records":
        _run_records_case(case, catalog, store)
        return

    provider_rows = _provider_rows(case)
    request = _request(catalog, case["query"], query_id=case["caseId"])
    if "error" in case:
        with pytest.raises(SemanticQueryError, match=case["error"]["code"]) as exc_info:
            execute_semantic_query(
                request,
                catalog=catalog,
                analysis_store=store,
                defect_provider=_defect_provider(provider_rows),
            )
        assert exc_info.value.status_code == case["error"]["statusCode"]
        return

    result = execute_semantic_query(
        request,
        catalog=catalog,
        analysis_store=store,
        defect_provider=_defect_provider(provider_rows),
    )
    _assert_query_result(result, case["expected"])


def test_semantic_execution_goldens(catalog: OntologyCatalog, tmp_path: Path) -> None:
    cases = _load_cases()
    assert len(cases) >= 10
    for case in cases:
        _execute_case(case, catalog, tmp_path / f"{case['caseId']}.db")