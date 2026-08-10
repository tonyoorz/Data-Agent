from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import backend.analytics.api as analytics_api
from backend.analytics.agent_actor_capability import ACTOR_CAPABILITY_HEADER, create_actor_capability
from backend.analytics.api import app
from backend.analytics.ontology import OntologyCatalog, load_ontology, ontology_fingerprint
from backend.analytics.semantic_analysis_store import SemanticAnalysisStore
from backend.analytics.semantic_query import SemanticQueryError, execute_semantic_query, execute_semantic_records


REPO_ROOT = Path(__file__).resolve().parents[2]
API_CAPABILITY_SECRET = "semantic-api-capability-secret"


@pytest.fixture(scope="module")
def catalog():
    return load_ontology(root=REPO_ROOT)


def _payload(catalog, *, metric_id: str = "defect.count", entity_id: str = "quality.defect") -> dict[str, Any]:
    policy_dimension = "org.team" if entity_id == "testing.test_run" else "org.problem_finder_team"
    return {
        "schemaVersion": "1.0",
        "queryId": "query-1",
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "query": {
            "schemaVersion": "1.0",
            "ontologyVersion": catalog.version,
            "schemaFingerprint": catalog.fingerprint,
            "intent": "aggregate",
            "entityIds": [entity_id],
            "metricIds": [metric_id],
            "dimensionIds": [],
            "filters": [{"dimensionId": policy_dimension, "operator": "in", "values": ["DTSV_China"], "source": "policy"}],
            "timeScopes": [],
            "comparison": None,
            "sort": [],
            "limit": 20,
        },
        "actorScope": {
            "actorId": "alice",
            "scopeHash": "scope-a",
            "workspaceIds": ["DTSV"],
            "projectIds": [],
            "teamIds": ["DTSV"],
            "allowedObjectTypes": ["quality.defect", "testing.test_run", "testing.test_case", "requirements.aida_node"],
            "allowedPropertyIds": [],
            "rowPolicyIds": ["dtsv"],
            "sensitiveFieldPolicyIds": [],
        },
    }


def _capability_actor(catalog) -> dict[str, Any]:
    actor_scope = _payload(catalog)["actorScope"]
    return {
        "actorId": actor_scope["actorId"],
        "scopeHash": actor_scope["scopeHash"],
        "scopes": {
            key: values
            for key, values in actor_scope.items()
            if key not in {"actorId", "scopeHash"} and values
        },
    }


def _capability_headers(catalog, *, token: str | None = None) -> dict[str, str]:
    capability = token or create_actor_capability(
        _capability_actor(catalog),
        secret=API_CAPABILITY_SECRET,
        nonce="semantic-api-capability-nonce",
    )
    return {ACTOR_CAPABILITY_HEADER: capability}


def _catalog_with_deny_rule(catalog: OntologyCatalog, *, metric_id: str, intents: list[str]) -> OntologyCatalog:
    bundle = deepcopy(catalog.bundle)
    rule_id = "business.test.no_metric_execution"
    bundle["businessRules"].append({
        "id": rule_id,
        "version": "1.0.0",
        "kind": "deny",
        "appliesTo": {"metricIds": [metric_id], "intents": intents},
        "effect": {
            "denialCode": f"BUSINESS_RULE_DENY:{rule_id}",
            "message": "Metric execution is blocked for this policy test.",
        },
        "governance": {"status": "approved", "owner": "Agent Security"},
    })
    return OntologyCatalog(version=catalog.version, fingerprint=ontology_fingerprint(bundle), bundle=bundle)


def _catalog_with_derived_project_rule(catalog: OntologyCatalog, *, intents: list[str] = ["aggregate"]) -> OntologyCatalog:
    bundle = deepcopy(catalog.bundle)
    rule_id = "business.test.project_scope"
    bundle["businessRules"].append({
        "id": rule_id,
        "version": "1.0.0",
        "kind": "derive",
        "appliesTo": {"metricIds": ["defect.count"], "intents": intents},
        "effect": {
            "derivedFilter": {"dimensionId": "product.project", "operator": "in", "values": ["SP25"]},
            "message": "This policy test is scoped to SP25.",
        },
        "governance": {"status": "approved", "owner": "Quality Analytics"},
    })
    return OntologyCatalog(version=catalog.version, fingerprint=ontology_fingerprint(bundle), bundle=bundle)


def test_semantic_query_api_reads_json_body_and_returns_safe_error(catalog, monkeypatch) -> None:
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", API_CAPABILITY_SECRET)
    client = TestClient(app)

    response = client.post("/api/semantic/query", json={}, headers=_capability_headers(catalog))

    assert response.status_code == 400
    payload = response.json()
    assert str(payload["code"]).startswith("SEMANTIC_REQUEST_MISSING:")
    assert payload["safeMessage"] == "semantic query rejected"
    assert payload["retryable"] is False


def test_semantic_records_api_reads_json_body_and_returns_safe_error(catalog, monkeypatch) -> None:
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", API_CAPABILITY_SECRET)
    client = TestClient(app)

    response = client.post("/api/semantic/records", json={}, headers=_capability_headers(catalog))

    assert response.status_code == 400
    payload = response.json()
    assert str(payload["code"]).startswith("SEMANTIC_RECORD_REQUEST_MISSING:")
    assert payload["safeMessage"] == "semantic records query rejected"
    assert payload["retryable"] is False


@pytest.mark.parametrize("path", ["/api/semantic/query", "/api/semantic/records"])
@pytest.mark.parametrize("capability_kind", ["missing", "tampered", "expired"])
def test_semantic_apis_reject_missing_tampered_and_expired_capabilities(
    path: str,
    capability_kind: str,
    catalog,
    monkeypatch,
) -> None:
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", API_CAPABILITY_SECRET)
    headers: dict[str, str] = {}
    expected_code = "ACTOR_CAPABILITY_INVALID"
    expected_status = 403
    if capability_kind == "missing":
        expected_code = "ACTOR_CAPABILITY_MISSING"
        expected_status = 401
    if capability_kind == "tampered":
        token = _capability_headers(catalog)[ACTOR_CAPABILITY_HEADER]
        altered = f"{token[:-1]}{'B' if token.endswith('A') else 'A'}"
        headers = {ACTOR_CAPABILITY_HEADER: altered}
    elif capability_kind == "expired":
        expired = create_actor_capability(
            _capability_actor(catalog),
            secret=API_CAPABILITY_SECRET,
            now=1_700_000_000,
            ttl_seconds=1,
            nonce="expired-semantic-capability",
        )
        headers = {ACTOR_CAPABILITY_HEADER: expired}
        expected_code = "ACTOR_CAPABILITY_EXPIRED"

    response = TestClient(app).post(path, json=_payload(catalog), headers=headers)

    assert response.status_code == expected_status
    assert response.json() == {
        "code": expected_code,
        "safeMessage": "agent capability rejected",
        "retryable": False,
    }


def test_semantic_api_overwrites_untrusted_body_actor_scope_from_verified_capability(catalog, monkeypatch) -> None:
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", API_CAPABILITY_SECRET)
    captured: dict[str, Any] = {}

    def fake_execute(payload, **_kwargs):
        captured.update(payload)
        return {"ok": True}

    monkeypatch.setattr(analytics_api, "execute_semantic_query", fake_execute)
    payload = _payload(catalog)
    payload["actorScope"] = {
        "actorId": "mallory",
        "scopeHash": "scope-admin",
        "workspaceIds": ["*"],
        "projectIds": ["*"],
        "teamIds": ["Other Team"],
        "allowedObjectTypes": ["*"],
        "allowedPropertyIds": ["*"],
        "rowPolicyIds": ["admin"],
        "sensitiveFieldPolicyIds": ["unredacted"],
    }

    response = TestClient(app).post(
        "/api/semantic/query",
        json=payload,
        headers=_capability_headers(catalog),
    )

    assert response.status_code == 200
    expected_scope = _payload(catalog)["actorScope"]
    expected_scope = {
        key: sorted(value) if isinstance(value, list) else value
        for key, value in expected_scope.items()
    }
    assert captured["actorScope"] == expected_scope


def _records_payload(catalog, *, analysis_ref: str | None, query: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "queryId": "records-1",
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "query": query,
        "analysisRef": analysis_ref,
        "actorScope": _payload(catalog)["actorScope"],
        "selections": [{"dimensionId": "product.ecu", "operator": "in", "values": ["HU"]}],
        "fields": ["defect_id", "name", "assigned_ecu", "status"],
        "page": 1,
        "pageSize": 1,
    }


def _trace_payload(catalog) -> dict[str, Any]:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "trace",
        "entityIds": ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
        "metricIds": [],
        "filters": [{"dimensionId": "org.team", "operator": "in", "values": ["DTSV_China"], "source": "policy"}],
    })
    return payload


def test_metric_result_issues_durable_analysis_ref_and_evidence(catalog, tmp_path: Path) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["product.ecu"]
    store = SemanticAnalysisStore(tmp_path / "analysis.db")
    result = execute_semantic_query(
        payload,
        catalog=catalog,
        analysis_store=store,
        defect_provider=lambda _filters: {
            "snapshot_version": "snap-analysis-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"},
            ],
        },
    )

    assert result["analysisRef"].startswith("analysis-")
    assert result["evidence"] == {
        "kind": "semantic_metric_result",
        "analysisRef": result["analysisRef"],
        "sourceRevisionId": "snap-analysis-1",
        "rowCount": 2,
        "metricValues": {"defect.count": 2},
        "groupRows": [{"product.ecu": "HU", "defect.count": 2}],
    }
    stored = store.load(result["analysisRef"], actor_scope_hash="scope-a")
    assert stored["query"] == payload["query"]
    assert stored["source_revision"]["revisionId"] == "snap-analysis-1"


def test_approved_but_unpublished_metric_fails_before_provider_execution(catalog) -> None:
    payload = _payload(catalog, metric_id="kpi.defect_detection_ratio")

    with pytest.raises(SemanticQueryError, match="SEMANTIC_METRIC_NOT_RUNTIME_READY:kpi.defect_detection_ratio") as exc_info:
        execute_semantic_query(
            payload,
            catalog=catalog,
            defect_provider=lambda _filters: pytest.fail("planned metrics must not reach a provider"),
        )

    assert exc_info.value.status_code == 422


def test_grouping_dimension_with_no_source_values_fails_closed(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["product.ecu"]

    with pytest.raises(SemanticQueryError, match="SEMANTIC_SOURCE_FIELD_UNAVAILABLE:product.ecu") as exc_info:
        execute_semantic_query(
            payload,
            catalog=catalog,
            defect_provider=lambda _filters: {
                "snapshot_version": "missing-ecu-1",
                "generated_from": {},
                "ticket_rows": [
                    {"ticket_id": "D-1", "problem_finder_team": "DTSV_China"},
                    {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "assigned_ecu": None},
                ],
            },
        )

    assert exc_info.value.status_code == 422


def test_grouping_dimension_with_partial_source_values_is_disclosed(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["product.ecu"]

    result = execute_semantic_query(
        payload,
        catalog=catalog,
        defect_provider=lambda _filters: {
            "snapshot_version": "partial-ecu-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China"},
            ],
        },
    )

    assert result["data"] == [
        {"product.ecu": "(missing)", "defect.count": 1},
        {"product.ecu": "HU", "defect.count": 1},
    ]
    assert result["quality"]["completeness"] == "partial"
    assert result["quality"]["warnings"] == ["DIMENSION_VALUES_PARTIALLY_MISSING:product.ecu"]


def test_records_continuation_returns_allowlisted_raw_rows_from_same_revision(catalog, tmp_path: Path) -> None:
    store = SemanticAnalysisStore(tmp_path / "analysis.db")
    metric_payload = _payload(catalog)
    metric_payload["query"]["dimensionIds"] = ["product.ecu"]
    rows = [
        {"ticket_id": "D-1", "ticket_name": "Audio issue", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU", "status": "Open"},
        {"ticket_id": "D-2", "ticket_name": "Navigation issue", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU", "status": "Fixed"},
        {"ticket_id": "D-3", "ticket_name": "Camera issue", "problem_finder_team": "DTSV_China", "assigned_ecu": "ADAS", "status": "Open"},
    ]
    aggregate = execute_semantic_query(
        metric_payload,
        catalog=catalog,
        analysis_store=store,
        defect_provider=lambda _filters: {"snapshot_version": "snap-records-1", "generated_from": {}, "ticket_rows": rows},
    )
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {"snapshot_version": "snap-records-1", "generated_from": {}, "ticket_rows": rows}

    result = execute_semantic_records(
        _records_payload(catalog, analysis_ref=aggregate["analysisRef"]),
        catalog=catalog,
        analysis_store=store,
        defect_provider=provider,
    )

    assert captured["snapshot_version"] == "snap-records-1"
    assert captured["assigned_ecus"] == ["HU"]
    assert result["analysisRef"] == aggregate["analysisRef"]
    assert result["sourceRevision"]["revisionId"] == "snap-records-1"
    assert result["data"] == [{"defect_id": "D-1", "name": "Audio issue", "assigned_ecu": "HU", "status": "Open"}]
    assert result["pagination"] == {"page": 1, "pageSize": 1, "totalRows": 2, "totalPages": 2}
    assert result["evidence"] == {
        "kind": "semantic_record_set",
        "analysisRef": aggregate["analysisRef"],
        "sourceRevisionId": "snap-records-1",
        "rowCount": 1,
        "totalRows": 2,
        "fieldIds": ["defect_id", "name", "assigned_ecu", "status"],
    }


def test_direct_record_query_issues_analysis_ref_without_prior_aggregate(catalog, tmp_path: Path) -> None:
    store = SemanticAnalysisStore(tmp_path / "analysis.db")
    semantic_query = deepcopy(_payload(catalog)["query"])
    semantic_query["intent"] = "list"
    semantic_query["dimensionIds"] = ["product.ecu"]
    request = _records_payload(catalog, analysis_ref=None, query=semantic_query)

    result = execute_semantic_records(
        request,
        catalog=catalog,
        analysis_store=store,
        defect_provider=lambda _filters: {
            "snapshot_version": "snap-direct-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "ticket_name": "Audio issue", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU", "status": "Open"},
                {"ticket_id": "D-2", "ticket_name": "Camera issue", "problem_finder_team": "DTSV_China", "assigned_ecu": "ADAS", "status": "Open"},
            ],
        },
    )

    assert result["analysisRef"].startswith("analysis-")
    assert result["sourceRevision"]["revisionId"] == "snap-direct-1"
    assert result["data"] == [{"defect_id": "D-1", "name": "Audio issue", "assigned_ecu": "HU", "status": "Open"}]


def test_records_continuation_rejects_scope_revision_selection_and_field_widening(catalog, tmp_path: Path) -> None:
    store = SemanticAnalysisStore(tmp_path / "analysis.db")
    metric_payload = _payload(catalog)
    metric_payload["query"]["dimensionIds"] = ["product.ecu"]
    aggregate = execute_semantic_query(
        metric_payload,
        catalog=catalog,
        analysis_store=store,
        defect_provider=lambda _filters: {
            "snapshot_version": "snap-safe-1",
            "generated_from": {},
            "ticket_rows": [{"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"}],
        },
    )
    base = _records_payload(catalog, analysis_ref=aggregate["analysisRef"])

    wrong_scope = deepcopy(base)
    wrong_scope["actorScope"]["scopeHash"] = "scope-b"
    with pytest.raises(SemanticQueryError, match="SEMANTIC_ANALYSIS_SCOPE_DENIED") as scope_error:
        execute_semantic_records(wrong_scope, catalog=catalog, analysis_store=store)
    assert scope_error.value.status_code == 403

    with pytest.raises(SemanticQueryError, match="SEMANTIC_ANALYSIS_REVISION_STALE") as revision_error:
        execute_semantic_records(
            base,
            catalog=catalog,
            analysis_store=store,
            defect_provider=lambda _filters: {"snapshot_version": "snap-safe-2", "generated_from": {}, "ticket_rows": []},
        )
    assert revision_error.value.status_code == 409

    wrong_selection = deepcopy(base)
    wrong_selection["selections"] = [{"dimensionId": "product.project", "operator": "in", "values": ["P1"]}]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_RECORD_SELECTION_NOT_IN_ANALYSIS"):
        execute_semantic_records(wrong_selection, catalog=catalog, analysis_store=store)

    wrong_field = deepcopy(base)
    wrong_field["fields"] = ["requirements_json"]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_RECORD_FIELD_DENIED"):
        execute_semantic_records(wrong_field, catalog=catalog, analysis_store=store)


def test_defect_metric_is_grouped_with_scope_and_revision(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["product.ecu"]
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {
            "snapshot_version": "snap-7",
            "generated_from": {"fetched_at": "2026-07-15T00:00:00Z"},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU"},
                {"ticket_id": "D-3", "problem_finder_team": "OTHER", "assigned_ecu": "ADAS"},
            ],
        }

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=provider)

    assert captured["problem_finder_teams"] == ["DTSV_China"]
    assert result["data"] == [{"product.ecu": "HU", "defect.count": 2}]
    assert result["summary"] == {"metrics": {"defect.count": 2}, "rowCount": 2}
    assert result["sourceRevision"]["revisionId"] == "snap-7"
    assert result["scope"]["actorScopeHash"] == "scope-a"
    assert "SOURCE_STALE:analytics.full_picture_defects" in result["quality"]["warnings"]
    assert result["quality"]["completeness"] == "partial"


def test_approved_team_discovery_metric_is_executable(catalog) -> None:
    payload = _payload(catalog, metric_id="team.defect_discovery_count")
    payload["query"]["dimensionIds"] = ["org.problem_finder_team"]
    result = execute_semantic_query(
        payload,
        catalog=catalog,
        defect_provider=lambda _filters: {
            "snapshot_version": "team-discovery-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China"},
                {"ticket_id": "D-3", "problem_finder_team": "OTHER"},
            ],
        },
    )

    assert result["data"] == [{"org.problem_finder_team": "DTSV_China", "team.defect_discovery_count": 2}]
    assert result["summary"]["metrics"]["team.defect_discovery_count"] == 2


def test_metric_required_filter_is_enforced_independently_of_actor_policy(catalog) -> None:
    payload = _payload(catalog, metric_id="team.defect_discovery_count")
    payload["query"]["filters"] = []
    payload["actorScope"]["workspaceIds"] = []
    payload["actorScope"]["teamIds"] = []

    with pytest.raises(SemanticQueryError, match="SEMANTIC_METRIC_REQUIRED_FILTER_MISSING:team.defect_discovery_count:org.problem_finder_team"):
        execute_semantic_query(payload, catalog=catalog)


def test_approved_deny_rule_blocks_direct_semantic_metric_execution(catalog) -> None:
    denied_catalog = _catalog_with_deny_rule(catalog, metric_id="defect.created_count", intents=["rank"])
    payload = _payload(denied_catalog, metric_id="defect.created_count")
    payload["query"].update({
        "intent": "rank",
        "dimensionIds": ["product.ecu"],
        "sort": [{"fieldId": "defect.created_count", "direction": "desc"}],
    })

    with pytest.raises(SemanticQueryError, match="SEMANTIC_BUSINESS_RULE_DENIED") as exc_info:
        execute_semantic_query(
            payload,
            catalog=denied_catalog,
            defect_provider=lambda _filters: {"snapshot_version": "deny-metric-1", "generated_from": {}, "ticket_rows": []},
        )

    assert exc_info.value.status_code == 403


def test_approved_deny_rule_blocks_direct_semantic_record_execution(catalog, tmp_path: Path) -> None:
    denied_catalog = _catalog_with_deny_rule(catalog, metric_id="defect.count", intents=["drilldown"])
    query = deepcopy(_payload(denied_catalog)["query"])
    query["intent"] = "list"
    request = _records_payload(denied_catalog, analysis_ref=None, query=query)
    request["selections"] = []

    with pytest.raises(SemanticQueryError, match="SEMANTIC_BUSINESS_RULE_DENIED") as exc_info:
        execute_semantic_records(
            request,
            catalog=denied_catalog,
            analysis_store=SemanticAnalysisStore(tmp_path / "deny-rule-analysis.db"),
            defect_provider=lambda _filters: {"snapshot_version": "deny-record-1", "generated_from": {}, "ticket_rows": []},
        )

    assert exc_info.value.status_code == 403


def test_approved_required_time_rule_blocks_direct_semantic_metric_execution(catalog) -> None:
    payload = _payload(catalog, metric_id="defect.created_count")
    payload["query"]["timeScopes"] = [{
        "role": "primary",
        "fieldId": "time.defect_last_modified",
        "start": "2026-07-01",
        "end": "2026-07-15",
        "timezone": "Asia/Shanghai",
        "anchorAt": "2026-07-15T04:00:00.000Z",
    }]

    with pytest.raises(SemanticQueryError, match="SEMANTIC_BUSINESS_RULE_REQUIREMENT_UNMET") as exc_info:
        execute_semantic_query(
            payload,
            catalog=catalog,
            defect_provider=lambda _filters: {"snapshot_version": "require-time-1", "generated_from": {}, "ticket_rows": []},
        )

    assert exc_info.value.status_code == 400


def test_semantic_api_returns_safe_business_rule_code_for_required_time_rejection(catalog, monkeypatch) -> None:
    monkeypatch.setenv("VIZION_AGENT_ACTOR_CAPABILITY_SECRET", API_CAPABILITY_SECRET)
    payload = _payload(catalog, metric_id="defect.created_count")
    payload["query"]["timeScopes"] = [{
        "role": "primary",
        "fieldId": "time.defect_last_modified",
        "start": "2026-07-01",
        "end": "2026-07-15",
        "timezone": "Asia/Shanghai",
        "anchorAt": "2026-07-15T04:00:00.000Z",
    }]

    response = TestClient(app).post(
        "/api/semantic/query",
        json=payload,
        headers=_capability_headers(catalog),
    )

    assert response.status_code == 400
    assert response.json() == {
        "code": "SEMANTIC_BUSINESS_RULE_REQUIREMENT_UNMET",
        "ruleCodes": ["BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time"],
        "safeMessage": "semantic query rejected",
        "retryable": False,
    }


def test_approved_derive_rule_scopes_direct_semantic_metric_execution(catalog) -> None:
    derived_catalog = _catalog_with_derived_project_rule(catalog)
    payload = _payload(derived_catalog)
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {
            "snapshot_version": "derive-project-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "project": "SP25"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "project": "OTHER"},
            ],
        }

    result = execute_semantic_query(payload, catalog=derived_catalog, defect_provider=provider)

    assert captured["projects"] == ["SP25"]
    assert result["summary"]["metrics"] == {"defect.count": 1}
    assert result["businessRules"] == {"applied": ["BUSINESS_RULE_DERIVE:business.test.project_scope"]}


def test_approved_derive_rule_scopes_direct_semantic_record_execution(catalog, tmp_path: Path) -> None:
    derived_catalog = _catalog_with_derived_project_rule(catalog, intents=["drilldown"])
    query = deepcopy(_payload(derived_catalog)["query"])
    query["intent"] = "list"
    request = _records_payload(derived_catalog, analysis_ref=None, query=query)
    request["selections"] = []
    request["fields"] = ["defect_id", "project"]
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {
            "snapshot_version": "derive-project-records-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "project": "SP25"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "project": "OTHER"},
            ],
        }

    result = execute_semantic_records(
        request,
        catalog=derived_catalog,
        analysis_store=SemanticAnalysisStore(tmp_path / "derive-record-analysis.db"),
        defect_provider=provider,
    )

    assert captured["projects"] == ["SP25"]
    assert result["data"] == [{"defect_id": "D-1", "project": "SP25"}]
    assert result["businessRules"] == {"applied": ["BUSINESS_RULE_DERIVE:business.test.project_scope"]}


def test_severe_defect_record_query_applies_classification_and_bi_definition(catalog, tmp_path: Path) -> None:
    query = deepcopy(_payload(catalog)["query"])
    query.update({
        "intent": "list",
        "metricIds": ["defect.severe_count"],
        "dimensionIds": [],
        "timeScopes": [{
            "role": "primary",
            "fieldId": "time.defect_creation_date",
            "start": "2026-08-01",
            "end": "2026-08-06",
            "timezone": "Asia/Shanghai",
            "anchorAt": "2026-08-06T07:00:00.000Z",
        }],
        "sort": [{"fieldId": "time.defect_creation_date", "direction": "desc"}],
    })
    request = _records_payload(catalog, analysis_ref=None, query=query)
    request["selections"] = []
    request["fields"] = ["defect_id", "name", "reporting_class", "problem_severity"]
    request["page"] = 1
    request["pageSize"] = 20

    result = execute_semantic_records(
        request,
        catalog=catalog,
        analysis_store=SemanticAnalysisStore(tmp_path / "severe-defect-records.db"),
        defect_provider=lambda _filters: {
            "snapshot_version": "severe-defect-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "ticket_name": "Candidate with high BI", "creation_time": "2026-08-04T09:00:00Z", "problem_finder_team": "DTSV_China", "classification": "Showstopper_Candidate", "problem_severity": "05-unsatisfactory"},
                {"ticket_id": "D-2", "ticket_name": "Confirmed with high BI", "creation_time": "2026-08-05T09:00:00Z", "problem_finder_team": "DTSV_China", "classification": "Showstopper_Confirmed", "problem_severity": "06-customer irritated"},
                {"ticket_id": "D-3", "ticket_name": "Candidate but low BI", "creation_time": "2026-08-06T09:00:00Z", "problem_finder_team": "DTSV_China", "classification": "Showstopper_Candidate", "problem_severity": "07-customer noticed"},
                {"ticket_id": "D-4", "ticket_name": "Top Issue but not Showstopper", "creation_time": "2026-08-06T10:00:00Z", "problem_finder_team": "DTSV_China", "classification": "Top_Issue_Confirmed", "problem_severity": "05-unsatisfactory"},
                {"ticket_id": "D-5", "ticket_name": "Explicit non-showstopper", "creation_time": "2026-08-06T11:00:00Z", "problem_finder_team": "DTSV_China", "classification": "No_Showstopper_Candidate", "problem_severity": "05-unsatisfactory"},
            ],
        },
    )

    assert result["data"] == [
        {"defect_id": "D-2", "name": "Confirmed with high BI", "reporting_class": "Showstopper_Confirmed", "problem_severity": "06-customer irritated"},
        {"defect_id": "D-1", "name": "Candidate with high BI", "reporting_class": "Showstopper_Candidate", "problem_severity": "05-unsatisfactory"},
    ]
    assert result["businessRules"] == {
        "applied": [
            "BUSINESS_RULE_DERIVE:business.severe_defect.business_impact",
            "BUSINESS_RULE_DERIVE:business.severe_defect.classification",
        ],
    }


def test_empty_result_is_zero_not_missing(catalog) -> None:
    result = execute_semantic_query(
        _payload(catalog),
        catalog=catalog,
        defect_provider=lambda _filters: {"snapshot_version": "snap-empty", "ticket_rows": [], "generated_from": {}},
    )

    assert result["summary"]["metrics"]["defect.count"] == 0
    assert result["quality"]["missingness"] == "zero"
    assert result["quality"]["completeness"] == "complete"


def test_stale_snapshot_quality_warning_is_deterministic(catalog) -> None:
    quality_cases = [
        json.loads(line)
        for line in (REPO_ROOT / "evals" / "main-agent" / "target" / "semantic-quality-golden.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    expected = next(item["expected"] for item in quality_cases if item["caseId"] == "quality-005-stale-snapshot")
    result = execute_semantic_query(
        _payload(catalog),
        catalog=catalog,
        defect_provider=lambda _filters: {
            "snapshot_version": "snap-stale-1",
            "generated_from": {"fetched_at": "2026-07-01T00:00:00Z"},
            "ticket_rows": [],
        },
        now=lambda: datetime(2026, 7, 15, tzinfo=timezone.utc),
    )

    assert result["quality"]["completeness"] == expected["completeness"]
    assert result["quality"]["warnings"] == [expected["warning"]]


def test_comparison_values_are_union_filtered_and_grouped(catalog) -> None:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "compare",
        "dimensionIds": ["product.os"],
        "filters": [
            {"dimensionId": "product.os", "operator": "in", "values": ["OS8", "OS9"], "source": "user"},
            {"dimensionId": "org.problem_finder_team", "operator": "in", "values": ["DTSV_China"], "source": "policy"},
        ],
        "comparison": {"kind": "dimension_values", "dimensionId": "product.os", "groups": ["OS8", "OS9"]},
    })
    rows = [
        {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "os": "OS8"},
        {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "os": "OS9"},
        {"ticket_id": "D-3", "problem_finder_team": "DTSV_China", "os": "OS9"},
        {"ticket_id": "D-4", "problem_finder_team": "DTSV_China", "os": "OS7"},
    ]

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=lambda _filters: {"snapshot_version": "compare-1", "ticket_rows": rows, "generated_from": {}})

    assert result["data"] == [
        {"product.os": "OS9", "defect.count": 2},
        {"product.os": "OS8", "defect.count": 1},
    ]
    assert result["summary"] == {"metrics": {"defect.count": 3}, "rowCount": 3}


def test_defect_trend_groups_business_dates_in_ascending_order(catalog) -> None:
    payload = _payload(catalog, metric_id="defect.created_count")
    payload["query"].update({
        "intent": "trend",
        "dimensionIds": ["time.defect_creation_date"],
        "timeScopes": [{
            "role": "primary", "fieldId": "time.defect_creation_date", "start": "2026-05-01", "end": "2026-07-15",
            "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z",
        }],
        "sort": [{"fieldId": "time.defect_creation_date", "direction": "asc"}],
        "limit": 200,
    })
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {
            "snapshot_version": "trend-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "creation_time": "2026-05-02T01:00:00Z"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "creation_time": "2026-05-02"},
                {"ticket_id": "D-3", "problem_finder_team": "DTSV_China", "creation_time": "2026-07-14T20:00:00Z"},
                {"ticket_id": "D-4", "problem_finder_team": "DTSV_China", "creation_time": "2026-04-30T12:00:00Z"},
            ],
        }

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=provider)

    assert captured["creation_time_start"] == "2026-05-01"
    assert captured["creation_time_end"] == "2026-07-15"
    assert result["data"] == [
        {"time.defect_creation_date": "2026-05-02", "defect.created_count": 2},
        {"time.defect_creation_date": "2026-07-15", "defect.created_count": 1},
    ]
    assert result["summary"] == {"metrics": {"defect.created_count": 3}, "rowCount": 3}


def test_time_period_comparison_executes_both_scopes(catalog) -> None:
    payload = _payload(catalog, metric_id="defect.created_count")
    baseline = {"role": "baseline", "fieldId": "time.defect_creation_date", "start": "2026-06-01", "end": "2026-06-30", "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z"}
    comparison = {"role": "comparison", "fieldId": "time.defect_creation_date", "start": "2026-07-01", "end": "2026-07-15", "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z"}
    payload["query"].update({
        "intent": "compare",
        "dimensionIds": ["time.defect_creation_date"],
        "timeScopes": [baseline, comparison],
        "comparison": {
            "kind": "time_periods",
            "dimensionId": "time.defect_creation_date",
            "groups": ["2026-06-01/2026-06-30", "2026-07-01/2026-07-15"],
        },
        "sort": [{"fieldId": "time.defect_creation_date", "direction": "asc"}],
        "limit": 200,
    })
    rows = [
        {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "creation_time": "2026-06-15T10:00:00Z"},
        {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "creation_time": "2026-07-01T10:00:00Z"},
        {"ticket_id": "D-3", "problem_finder_team": "DTSV_China", "creation_time": "2026-07-02T10:00:00Z"},
        {"ticket_id": "D-4", "problem_finder_team": "DTSV_China", "creation_time": "2026-05-31T10:00:00Z"},
    ]

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=lambda _filters: {"snapshot_version": "period-compare-1", "ticket_rows": rows, "generated_from": {}})

    assert result["data"] == [
        {"time.defect_creation_date": "2026-06-01/2026-06-30", "defect.created_count": 1},
        {"time.defect_creation_date": "2026-07-01/2026-07-15", "defect.created_count": 2},
    ]
    assert result["summary"] == {"metrics": {"defect.created_count": 3}, "rowCount": 3}


def test_os_trend_comparison_keeps_product_and_business_date_grains(catalog) -> None:
    payload = _payload(catalog, metric_id="defect.created_count")
    payload["query"].update({
        "intent": "compare",
        "dimensionIds": ["product.os", "time.defect_creation_date"],
        "filters": [
            {"dimensionId": "product.os", "operator": "in", "values": ["OS8", "OS9"], "source": "user"},
            {"dimensionId": "org.problem_finder_team", "operator": "in", "values": ["DTSV_China"], "source": "policy"},
        ],
        "timeScopes": [{
            "role": "primary", "fieldId": "time.defect_creation_date", "start": "2026-05-01", "end": "2026-07-15",
            "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z",
        }],
        "comparison": {"kind": "dimension_values", "dimensionId": "product.os", "groups": ["OS8", "OS9"]},
        "sort": [{"fieldId": "time.defect_creation_date", "direction": "asc"}],
        "limit": 200,
    })
    rows = [
        {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "os": "OS8", "creation_time": "2026-05-02T01:00:00Z"},
        {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "os": "OS9", "creation_time": "2026-05-02T02:00:00Z"},
        {"ticket_id": "D-3", "problem_finder_team": "DTSV_China", "os": "OS9", "creation_time": "2026-05-02T03:00:00Z"},
        {"ticket_id": "D-4", "problem_finder_team": "DTSV_China", "os": "OS8", "creation_time": "2026-06-01T01:00:00Z"},
        {"ticket_id": "D-5", "problem_finder_team": "DTSV_China", "os": "OS7", "creation_time": "2026-06-01T01:00:00Z"},
    ]

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=lambda _filters: {"snapshot_version": "os-trend-1", "ticket_rows": rows, "generated_from": {}})

    assert result["data"] == [
        {"product.os": "OS9", "time.defect_creation_date": "2026-05-02", "defect.created_count": 2},
        {"product.os": "OS8", "time.defect_creation_date": "2026-05-02", "defect.created_count": 1},
        {"product.os": "OS8", "time.defect_creation_date": "2026-06-01", "defect.created_count": 1},
    ]
    assert result["summary"] == {"metrics": {"defect.created_count": 4}, "rowCount": 4}


def test_dynamic_pu_filter_is_enforced_by_provider_and_data_plane(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["filters"].insert(0, {"dimensionId": "product.pu", "operator": "in", "values": ["25-07"], "source": "user"})
    captured: dict[str, Any] = {}

    def provider(filters: dict[str, Any]) -> dict[str, Any]:
        captured.update(filters)
        return {
            "snapshot_version": "pu-filter-1",
            "generated_from": {},
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "pu": "25-07"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "pu": "25-03"},
            ],
        }

    result = execute_semantic_query(payload, catalog=catalog, defect_provider=provider)

    assert captured["pus"] == ["25-07"]
    assert result["summary"] == {"metrics": {"defect.count": 1}, "rowCount": 1}


def test_test_run_metrics_use_team_scope_status_and_time(catalog) -> None:
    payload = _payload(catalog, metric_id="testing.passed_run_count", entity_id="testing.test_run")
    payload["query"]["dimensionIds"] = ["product.project"]
    payload["query"]["timeScopes"] = [{
        "role": "primary",
        "fieldId": "time.test_finished_date",
        "start": "2026-07-01",
        "end": "2026-07-31",
        "timezone": "Asia/Shanghai",
        "anchorAt": "2026-07-15T04:00:00.000Z",
    }]
    rows = [
        {"mr_id": "MR-1", "team": "DTSV_China", "project": "P1", "status": "Passed", "finished": "2026-07-02T10:00:00Z"},
        {"mr_id": "MR-2", "team": "DTSV_China", "project": "P1", "status": "Failed", "finished": "2026-07-03T10:00:00Z"},
        {"mr_id": "MR-3", "team": "DTSV_China", "project": "P2", "status": "Passed", "finished": "2026-06-30T10:00:00Z"},
        {"mr_id": "MR-4", "team": "OTHER", "project": "P2", "status": "Passed", "finished": "2026-07-04T10:00:00Z"},
    ]

    result = execute_semantic_query(payload, catalog=catalog, run_provider=lambda: rows)

    assert result["data"] == [{"product.project": "P1", "testing.passed_run_count": 1}]
    assert result["summary"]["metrics"]["testing.passed_run_count"] == 1
    assert result["summary"]["rowCount"] == 2


def test_test_run_time_query_fails_closed_when_source_field_is_absent(catalog) -> None:
    payload = _payload(catalog, metric_id="testing.run_count", entity_id="testing.test_run")
    payload["query"]["timeScopes"] = [{
        "role": "primary", "fieldId": "time.test_finished_date", "start": "2026-07-01", "end": "2026-07-31",
        "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z",
    }]

    with pytest.raises(SemanticQueryError, match="SEMANTIC_SOURCE_FIELD_UNAVAILABLE") as exc_info:
        execute_semantic_query(payload, catalog=catalog, run_provider=lambda: [{"mr_id": "MR-1", "team": "DTSV_China"}])
    assert exc_info.value.status_code == 422


def test_traceability_passes_and_rechecks_team_scope(catalog) -> None:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "trace",
        "entityIds": ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
        "metricIds": [],
        "filters": [{"dimensionId": "org.team", "operator": "in", "values": ["DTSV_China"], "source": "policy"}],
    })
    captured: dict[str, Any] = {}

    def provider(query_params: dict[str, Any]) -> dict[str, Any]:
        captured.update(query_params)
        return {
            "summary": {"total_runs": 2},
            "traceability_chain_rows": [
                {"run_id": "MR-1", "scope_team": "DTSV_China"},
                {"run_id": "MR-2", "scope_team": "OTHER"},
            ],
        }

    result = execute_semantic_query(payload, catalog=catalog, trace_provider=provider)

    assert captured == {"teams": ["DTSV_China"]}
    assert result["data"] == [{"run_id": "MR-1", "scope_team": "DTSV_China"}]
    assert result["summary"]["rowCount"] == 1
    assert result["lineage"] == {
        "path": [
            {
                "id": "testing.test_case.validates.aida_node",
                "predicate": "validates",
                "sourceEntity": "testing.test_case",
                "targetEntity": "requirements.aida_node",
                "cardinality": "many_to_many",
                "joinPath": ["testing.test_case", "requirements.aida_node"],
                "explosionPolicy": "distinct_source",
            },
            {
                "id": "testing.test_run.executes.test_case",
                "predicate": "executes",
                "sourceEntity": "testing.test_run",
                "targetEntity": "testing.test_case",
                "cardinality": "many_to_one",
                "joinPath": ["testing.test_run", "testing.test_case"],
            },
            {
                "id": "quality.defect.detected_in.test_run",
                "predicate": "detected_in",
                "sourceEntity": "quality.defect",
                "targetEntity": "testing.test_run",
                "cardinality": "many_to_one",
                "joinPath": ["quality.defect", "testing.test_run"],
            },
        ],
        "sourceRevision": result["sourceRevision"],
        "evidence": {
            "rowCount": 1,
            "rowIndexes": [0],
            "relationshipIds": [
                "testing.test_case.validates.aida_node",
                "testing.test_run.executes.test_case",
                "quality.defect.detected_in.test_run",
            ],
        },
    }


def test_traceability_rejects_an_unsupported_join_before_reading_source_data(catalog) -> None:
    bundle = deepcopy(catalog.bundle)
    bundle["relationships"] = [
        relationship
        for relationship in bundle["relationships"]
        if relationship["id"] != "testing.test_run.executes.test_case"
    ]
    unsupported_catalog = OntologyCatalog(
        version=catalog.version,
        fingerprint=ontology_fingerprint(bundle),
        bundle=bundle,
    )

    with pytest.raises(SemanticQueryError, match="SEMANTIC_UNSUPPORTED_JOIN:testing.test_case:testing.test_run") as exc_info:
        execute_semantic_query(
            _trace_payload(unsupported_catalog),
            catalog=unsupported_catalog,
            trace_provider=lambda _params: pytest.fail("trace provider must not run for an unsupported join"),
        )

    assert exc_info.value.status_code == 422


def test_traceability_rejects_an_unbounded_many_to_many_path_before_reading_source_data(catalog) -> None:
    bundle = deepcopy(catalog.bundle)
    next(
        relationship
        for relationship in bundle["relationships"]
        if relationship["id"] == "testing.test_case.validates.aida_node"
    ).pop("explosionPolicy")
    unbounded_catalog = OntologyCatalog(
        version=catalog.version,
        fingerprint=ontology_fingerprint(bundle),
        bundle=bundle,
    )

    with pytest.raises(SemanticQueryError, match="SEMANTIC_UNBOUNDED_CARDINALITY:testing.test_case.validates.aida_node") as exc_info:
        execute_semantic_query(
            _trace_payload(unbounded_catalog),
            catalog=unbounded_catalog,
            trace_provider=lambda _params: pytest.fail("trace provider must not run for an unbounded path"),
        )

    assert exc_info.value.status_code == 422


def test_traceability_rechecks_status_and_shanghai_time_scope(catalog) -> None:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "trace",
        "entityIds": ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
        "metricIds": [],
        "filters": [
            {"dimensionId": "testing.run_status", "operator": "in", "values": ["Failed"], "source": "user"},
            {"dimensionId": "org.team", "operator": "in", "values": ["DTSV_China"], "source": "policy"},
        ],
        "timeScopes": [{
            "role": "primary", "fieldId": "time.test_finished_date", "start": "2026-07-13", "end": "2026-07-15",
            "timezone": "Asia/Shanghai", "anchorAt": "2026-07-15T04:00:00.000Z",
        }],
    })
    rows = [
        {"run_id": "MR-1", "scope_team": "DTSV_China", "run_status": "Failed", "run_finished": "2026-07-12T20:00:00Z"},
        {"run_id": "MR-2", "scope_team": "DTSV_China", "run_status": "Passed", "run_finished": "2026-07-13T01:00:00Z"},
        {"run_id": "MR-3", "scope_team": "OTHER", "run_status": "Failed", "run_finished": "2026-07-13T01:00:00Z"},
        {"run_id": "MR-4", "scope_team": "DTSV_China", "run_status": "Failed", "run_finished": "2026-07-15T20:00:00Z"},
    ]

    result = execute_semantic_query(
        payload,
        catalog=catalog,
        trace_provider=lambda _params: {"summary": {}, "traceability_chain_rows": rows},
    )

    assert result["data"] == [rows[0]]
    assert result["summary"]["rowCount"] == 1


def test_traceability_executes_and_rechecks_aida_subject_scope(catalog) -> None:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "trace",
        "entityIds": ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
        "metricIds": [],
        "filters": [
            {"dimensionId": "requirements.aida", "operator": "in", "values": ["REQ-42"], "source": "user"},
            {"dimensionId": "org.team", "operator": "in", "values": ["DTSV_China"], "source": "policy"},
        ],
    })
    captured: dict[str, Any] = {}
    rows = [
        {"run_id": "MR-1", "scope_team": "DTSV_China", "feature_ids": "REQ-42"},
        {"run_id": "MR-2", "scope_team": "DTSV_China", "story_ids": "REQ-99"},
    ]

    def provider(query_params: dict[str, Any]) -> dict[str, Any]:
        captured.update(query_params)
        return {"summary": {}, "traceability_chain_rows": rows}

    result = execute_semantic_query(payload, catalog=catalog, trace_provider=provider)

    assert captured == {"aidas": ["REQ-42"], "teams": ["DTSV_China"]}
    assert result["data"] == [rows[0]]
    assert result["summary"]["rowCount"] == 1


def test_traceability_returns_governed_untraced_testcase_gaps(catalog) -> None:
    payload = _payload(catalog)
    payload["query"].update({
        "intent": "trace",
        "entityIds": ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
        "metricIds": [],
        "filters": [
            {"dimensionId": "testing.trace_status", "operator": "in", "values": ["Untraced"], "source": "user"},
            {"dimensionId": "org.team", "operator": "in", "values": ["DTSV_China"], "source": "policy"},
        ],
    })
    trace = {
        "summary": {},
        "traceability_chain_rows": [{"run_id": "MR-TRACED", "scope_team": "DTSV_China"}],
        "gap_rows": [
            {"test_id": "TC-1", "team": "DTSV_China"},
            {"test_id": "TC-2", "team": "OTHER"},
        ],
    }

    result = execute_semantic_query(payload, catalog=catalog, trace_provider=lambda _params: trace)

    assert result["data"] == [{"test_id": "TC-1", "team": "DTSV_China"}]
    assert result["summary"]["rowCount"] == 1


def test_object_and_project_scope_are_enforced_server_side(catalog) -> None:
    payload = _payload(catalog)
    payload["actorScope"]["allowedObjectTypes"] = ["testing.test_run"]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_OBJECT_SCOPE_DENIED"):
        execute_semantic_query(payload, catalog=catalog, defect_provider=lambda _filters: {"ticket_rows": []})

    payload = _payload(catalog)
    payload["actorScope"]["projectIds"] = ["SP25"]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_POLICY_FILTER_REQUIRED:product.project"):
        execute_semantic_query(payload, catalog=catalog, defect_provider=lambda _filters: {"ticket_rows": []})

    payload["query"]["filters"].append({"dimensionId": "product.project", "operator": "in", "values": ["SP25"], "source": "policy"})
    result = execute_semantic_query(
        payload,
        catalog=catalog,
        defect_provider=lambda _filters: {
            "ticket_rows": [
                {"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "project": "SP25"},
                {"ticket_id": "D-2", "problem_finder_team": "DTSV_China", "project": "OTHER"},
            ],
            "generated_from": {},
        },
    )
    assert result["summary"]["metrics"]["defect.count"] == 1


def test_confidential_dimension_requires_policy_and_is_pseudonymized(catalog) -> None:
    payload = _payload(catalog, metric_id="testing.run_count", entity_id="testing.test_run")
    payload["query"]["dimensionIds"] = ["org.tester"]
    rows = [{"mr_id": "MR-1", "team": "DTSV_China", "tester": "Alice Example", "status": "Passed"}]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_SENSITIVE_FIELD_DENIED:org.tester"):
        execute_semantic_query(payload, catalog=catalog, run_provider=lambda: rows)

    payload["actorScope"]["allowedPropertyIds"] = ["testing.test_run.tester"]
    payload["actorScope"]["sensitiveFieldPolicyIds"] = ["pseudonymize:confidential"]
    result = execute_semantic_query(payload, catalog=catalog, run_provider=lambda: rows)
    assert result["data"][0]["org.tester"].startswith("pseudonym-")
    assert "Alice Example" not in str(result)
    assert result["quality"]["redactionStatus"] == "applied"


def test_policy_filter_cannot_be_removed_or_widened(catalog) -> None:
    missing = _payload(catalog)
    missing["query"]["filters"] = []
    with pytest.raises(SemanticQueryError, match="SEMANTIC_POLICY_FILTER_REQUIRED") as exc_info:
        execute_semantic_query(missing, catalog=catalog)
    assert exc_info.value.status_code == 403

    widened = _payload(catalog)
    widened["query"]["filters"][0]["values"].append("OTHER")
    with pytest.raises(SemanticQueryError, match="SEMANTIC_SCOPE_FILTER_DENIED"):
        execute_semantic_query(widened, catalog=catalog)


def test_metric_entity_binding_prevents_scope_bypass(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["entityIds"] = []
    payload["query"]["filters"] = []

    with pytest.raises(SemanticQueryError, match="SEMANTIC_METRIC_ENTITY_REQUIRED"):
        execute_semantic_query(payload, catalog=catalog)


def test_draft_metric_and_stale_fingerprint_are_rejected(catalog) -> None:
    draft = _payload(catalog, metric_id="quality.defect_density")
    with pytest.raises(SemanticQueryError, match="ONTOLOGY_METRIC_NOT_APPROVED"):
        execute_semantic_query(draft, catalog=catalog)

    stale = _payload(catalog)
    stale["schemaFingerprint"] = "0" * 64
    with pytest.raises(SemanticQueryError, match="SEMANTIC_ONTOLOGY_VERSION_MISMATCH") as exc_info:
        execute_semantic_query(stale, catalog=catalog)
    assert exc_info.value.status_code == 409


def test_data_plane_enforces_compiled_limits_and_capabilities(catalog) -> None:
    limited_bundle = deepcopy(catalog.bundle)
    next(item for item in limited_bundle["constraints"] if item["id"] == "query.max_limit")["parameters"]["maximum"] = 3
    limited_catalog = OntologyCatalog(version=catalog.version, fingerprint=catalog.fingerprint, bundle=limited_bundle)
    limited = _payload(limited_catalog)
    limited["query"]["limit"] = 4
    with pytest.raises(SemanticQueryError, match="SEMANTIC_QUERY_LIMIT_INVALID"):
        execute_semantic_query(limited, catalog=limited_catalog)

    denied_bundle = deepcopy(catalog.bundle)
    next(item for item in denied_bundle["policies"] if item["id"] == "analytics.read_only")["allowedOperations"] = ["traceability_query"]
    denied_catalog = OntologyCatalog(version=catalog.version, fingerprint=catalog.fingerprint, bundle=denied_bundle)
    with pytest.raises(SemanticQueryError, match="SEMANTIC_OPERATION_DENIED") as exc_info:
        execute_semantic_query(_payload(denied_catalog), catalog=denied_catalog)
    assert exc_info.value.status_code == 403


def test_unknown_contract_fields_and_sql_payloads_are_rejected(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["sql"] = "SELECT * FROM secrets"
    with pytest.raises(SemanticQueryError, match="SEMANTIC_QUERY_UNKNOWN:sql"):
        execute_semantic_query(payload, catalog=catalog)

    nested = deepcopy(_payload(catalog))
    nested["query"]["filters"][0]["values"] = [{"$where": "1=1"}]
    with pytest.raises(SemanticQueryError, match="SEMANTIC_FILTER_VALUES_REQUIRED"):
        execute_semantic_query(nested, catalog=catalog)
