from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics.schema import ensure_schema


def _seed_ontology_context_db(db_path: Path) -> None:
    ensure_schema(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-ONTO-1",
                "Wakeup fails after restart",
                "IDCEVO",
                "CN",
                "PU26",
                "Speech",
                "Voice",
                "DTSV_China",
                "NA5",
                "Speech wakeup requirement",
                json.dumps({"data": [{"id": "REQ-1", "name": "Speech wakeup requirement"}]}),
                json.dumps({"seed": True}),
                "2026-07-20T08:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model,
                requirement, requirements_json, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-NORUN-1",
                "Remote services fail after overnight bus sleep",
                "IDCEVO",
                "CN",
                "PU26",
                "Remote Services",
                "MyBMW App",
                "DTSV_China",
                "NA6",
                "Remote service requirement",
                json.dumps({"data": [{"id": "REQ-REMOTE-1", "name": "Remote service requirement"}]}),
                json.dumps(
                    {
                        "description": "Precondition: sleep vehicle overnight. Action: use My BMW app to run remote services. Expected: remote services feedback should pass. Actual: first try failed; second try passed.",
                    }
                ),
                "2026-07-21T08:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_manual_runs(
                mr_id, defect_id, test_id, test_name, status, year, test_week,
                pu, top_aida, tester, project, fv, fvp, team, lead_model, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-ONTO-1",
                    "D-ONTO-1",
                    "T-ONTO-1",
                    "Speech wakeup regression",
                    "Failed",
                    "2026",
                    "2026-CW29",
                    "PU26",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Tester A",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    json.dumps({"seed": True}),
                    "2026-07-20T08:00:00Z",
                ),
                (
                    "MR-ONTO-2",
                    "",
                    "T-ONTO-1",
                    "Speech wakeup regression",
                    "Passed",
                    "2026",
                    "2026-CW28",
                    "PU26",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "Tester B",
                    "IDCEVO",
                    "Speech",
                    "Voice",
                    "DTSV_China",
                    "NA5",
                    json.dumps({"seed": True}),
                    "2026-07-13T08:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_run_traceability(
                run_id, test_id, test_name, scope_team, scope_release, source, year, status,
                run_finished, relation_type, related_id, related_name, related_subtype,
                related_path, parent_id, parent_name, parent_subtype, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "MR-ONTO-1",
                    "T-ONTO-1",
                    "Speech wakeup regression",
                    "DTSV_China",
                    "R-26-07",
                    "manual_runs",
                    "2026",
                    "Failed",
                    "2026-07-20T08:00:00Z",
                    "feature",
                    "F-ONTO-1",
                    "Speech wakeup feature CW29",
                    "feature",
                    "epic/speech-feature",
                    "E-ONTO-1",
                    "Speech epic",
                    "epic",
                    "2026-07-20T08:00:00Z",
                ),
                (
                    "MR-ONTO-1",
                    "T-ONTO-1",
                    "Speech wakeup regression",
                    "DTSV_China",
                    "R-26-07",
                    "manual_runs",
                    "2026",
                    "Failed",
                    "2026-07-20T08:00:00Z",
                    "story",
                    "S-ONTO-1",
                    "Speech wakeup story",
                    "story",
                    "epic/speech-feature/speech-story",
                    "F-ONTO-1",
                    "Speech wakeup feature CW29",
                    "feature",
                    "2026-07-20T08:00:00Z",
                ),
                (
                    "MR-ONTO-1",
                    "T-ONTO-1",
                    "Speech wakeup regression",
                    "DTSV_China",
                    "R-26-07",
                    "manual_runs",
                    "2026",
                    "Failed",
                    "2026-07-20T08:00:00Z",
                    "defect",
                    "D-ONTO-1",
                    "Wakeup fails after restart",
                    "defect",
                    "defect/wakeup",
                    "",
                    "",
                    "",
                    "2026-07-20T08:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()


def test_build_test_case_context_payload_returns_scope_results_and_traceability(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.ontology_context import build_test_case_context_payload

    db_path = tmp_path / "qgate_raw.db"
    _seed_ontology_context_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_test_case_context_payload(
        {
            "anchor": {"type": "test_id", "value": "T-ONTO-1"},
            "purpose": "create_test_case",
        }
    )

    assert payload["anchor"] == {
        "node_id": "testcase:T-ONTO-1",
        "node_type": "Testcase",
        "label": "Speech wakeup regression",
    }
    assert payload["business_scope"] == {
        "project": "IDCEVO",
        "pu": "PU26",
        "aida": "Use Speech operation [01.04.02.01.01.05]",
        "fv": "Speech",
        "fvp": "Voice",
        "team": "DTSV_China",
        "lead_model": "NA5",
        "release": "R-26-07",
        "planned_week": "2026-CW29",
    }
    assert payload["coverage_summary"] == {
        "related_testcases": 1,
        "latest_runs": 2,
        "passed": 1,
        "failed": 1,
        "requires_attention": 0,
        "planned": 0,
        "linked_defects": 1,
        "last_verified_week": "2026-CW29",
    }
    assert payload["tested_background"] == [
        {
            "test_id": "T-ONTO-1",
            "test_name": "Speech wakeup regression",
            "last_status": "Failed",
            "last_week": "2026-CW29",
            "evidence": ["manual_run:MR-ONTO-1", "manual_run:MR-ONTO-2"],
        }
    ]
    assert payload["traceability"] == {
        "epics": [{"id": "E-ONTO-1", "name": "Speech epic"}],
        "features": [{"id": "F-ONTO-1", "name": "Speech wakeup feature CW29"}],
        "stories": [{"id": "S-ONTO-1", "name": "Speech wakeup story"}],
        "defects": [{"id": "D-ONTO-1", "name": "Wakeup fails after restart"}],
    }
    assert payload["gaps"] == [
        {
            "gap_type": "failed_related_run",
            "description": "Related testcase has failed or requires-attention runs.",
        }
    ]
    assert payload["provenance"]["source_db"] == str(db_path)
    assert payload["provenance"]["ontology_version"] == "1.0"


def test_defect_anchor_returns_defect_context_when_no_runs_exist(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.ontology_context import build_test_case_context_payload

    db_path = tmp_path / "qgate_raw.db"
    _seed_ontology_context_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_test_case_context_payload(
        {
            "anchor": {"type": "defect_id", "value": "D-NORUN-1"},
            "purpose": "create_test_case",
        }
    )

    assert payload["anchor"] == {
        "node_id": "defect:D-NORUN-1",
        "node_type": "Defect",
        "label": "Remote services fail after overnight bus sleep",
    }
    assert payload["business_scope"] == {
        "project": "IDCEVO",
        "pu": "PU26",
        "aida": "",
        "fv": "Remote Services",
        "fvp": "MyBMW App",
        "team": "DTSV_China",
        "lead_model": "NA6",
        "release": "",
        "planned_week": "",
    }
    assert payload["defect_context"] == {
        "defect_id": "D-NORUN-1",
        "name": "Remote services fail after overnight bus sleep",
        "description": "Precondition: sleep vehicle overnight. Action: use My BMW app to run remote services. Expected: remote services feedback should pass. Actual: first try failed; second try passed.",
        "requirement": "Remote service requirement",
        "evidence": ["defect:D-NORUN-1"],
    }
    assert payload["coverage_summary"]["latest_runs"] == 0
    assert payload["gaps"] == [
        {"gap_type": "no_related_runs", "description": "No related manual runs were found for this anchor."},
        {"gap_type": "missing_traceability", "description": "No Feature or Story traceability was found for this anchor."},
    ]


def test_ontology_context_api_returns_test_case_context(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "qgate_raw.db"
    _seed_ontology_context_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.post(
        "/api/ontology/context",
        json={"anchor": {"type": "test_id", "value": "T-ONTO-1"}, "purpose": "create_test_case"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["anchor"]["node_id"] == "testcase:T-ONTO-1"
    assert payload["coverage_summary"]["latest_runs"] == 2
    assert payload["traceability"]["features"] == [{"id": "F-ONTO-1", "name": "Speech wakeup feature CW29"}]


def test_build_ontology_catalog_payload_reports_capabilities_and_source_counts(tmp_path: Path, monkeypatch) -> None:
    from backend.analytics.ontology_context import build_ontology_catalog_payload

    db_path = tmp_path / "qgate_raw.db"
    _seed_ontology_context_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))

    payload = build_ontology_catalog_payload()

    assert payload["ontology_version"] == "1.0"
    assert payload["source"]["db_path"] == str(db_path)
    assert payload["source"]["tables"]["octane_defects"]["rows"] == 2
    assert payload["source"]["tables"]["octane_manual_runs"]["rows"] == 2
    assert payload["source"]["tables"]["octane_run_traceability"]["rows"] == 3
    assert payload["entity_types"] == [
        {"id": "Defect", "capability_state": "available", "source_tables": ["octane_defects"]},
        {"id": "Testcase", "capability_state": "available", "source_tables": ["octane_manual_runs", "octane_traceability_testcases", "octane_testcases"]},
        {"id": "ManualRun", "capability_state": "available", "source_tables": ["octane_manual_runs"]},
        {"id": "Feature", "capability_state": "available", "source_tables": ["octane_run_traceability"]},
        {"id": "Story", "capability_state": "available", "source_tables": ["octane_run_traceability"]},
        {"id": "Requirement", "capability_state": "partial", "source_tables": ["octane_defects"]},
    ]
    assert {"id": "get_test_case_context", "primitive": "context", "capability_state": "available"} in payload["agent_tools"]
    assert {"id": "octane.defect.add_comment", "operation": "comment", "target_entity": "quality.defect", "capability_state": "dry_run_only", "execution_mode": "dry_run_only", "approval_required": True, "dry_run_required": True} in payload["actions"]
    assert {"id": "octane.defect.update_triage_fields", "operation": "update", "target_entity": "quality.defect", "capability_state": "disabled", "execution_mode": "disabled", "approval_required": True, "dry_run_required": True} in payload["actions"]
    assert {"id": "octane.defect.delete_work_item", "operation": "delete", "target_entity": "quality.defect", "capability_state": "blocked", "execution_mode": "blocked", "approval_required": True, "dry_run_required": True} in payload["actions"]
    assert payload["guardrails"] == [
        "Missing data is unknown, not zero.",
        "Duplicate-search similarity is evidence of similarity, not confirmed causality.",
        "Testcase drafting must call get_test_case_context before generating steps.",
        "Octane write/update/delete intents must be answered from Action Ontology capability states; disabled or blocked actions must not be executed.",
    ]


def test_ontology_catalog_api_returns_catalog(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "qgate_raw.db"
    _seed_ontology_context_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.get("/api/ontology/catalog")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ontology_version"] == "1.0"
    assert payload["source"]["tables"]["octane_manual_runs"]["rows"] == 2
    assert {"id": "get_test_case_context", "primitive": "context", "capability_state": "available"} in payload["agent_tools"]
    assert {"id": "octane.defect.delete_work_item", "operation": "delete", "target_entity": "quality.defect", "capability_state": "blocked", "execution_mode": "blocked", "approval_required": True, "dry_run_required": True} in payload["actions"]