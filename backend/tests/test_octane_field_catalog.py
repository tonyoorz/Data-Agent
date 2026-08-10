from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from backend.analytics.api import app
from backend.analytics_cli import main
from backend.analytics.octane_field_catalog import (
    build_local_octane_field_catalog,
    load_local_octane_field_catalog,
    reset_octane_field_catalog_cache,
    search_octane_fields,
)


def _seed_octane_db(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                problem_finder_team TEXT,
                model_series TEXT,
                raw_json TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                status TEXT,
                raw_json TEXT
            )
            """
        )
        defect_payloads = [
            {
                "id": "D-1",
                "name": "Remote service fails",
                "problem_finder_team_udf": {"type": "team", "id": "100", "name": "DTSV_China"},
                "model_series_udf": {"type": "list_node", "name": "NA6"},
                "software_version_udf": "IDCevo 26-11",
                "unused_empty_udf": "",
            },
            {
                "id": "D-2",
                "name": "Navigation audio issue",
                "problem_finder_team_udf": {"type": "team", "id": "100", "name": "DTSV_China"},
                "model_series_udf": {"type": "list_node", "name": "G60"},
                "software_version_udf": "IDCevo 26-07",
                "unused_empty_udf": None,
                "rare_business_udf": "only-one-row",
            },
        ]
        for payload in defect_payloads:
            conn.execute(
                "INSERT INTO octane_defects(defect_id, name, problem_finder_team, model_series, raw_json) VALUES (?, ?, ?, ?, ?)",
                (
                    payload["id"],
                    payload["name"],
                    payload["problem_finder_team_udf"]["name"],
                    payload["model_series_udf"]["name"],
                    json.dumps(payload),
                ),
            )
        conn.execute(
            "INSERT INTO octane_manual_runs(mr_id, status, raw_json) VALUES (?, ?, ?)",
            ("MR-1", "Passed", json.dumps({"id": "MR-1", "finished_udf": "2026-07-01T08:00:00Z"})),
        )
        conn.commit()
    finally:
        conn.close()


def test_build_local_octane_field_catalog_discovers_columns_raw_keys_and_udf_mappings(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    _seed_octane_db(db_path)

    catalog = build_local_octane_field_catalog(db_path=db_path, sample_limit=100)

    assert catalog["schemaVersion"] == "1.0"
    assert catalog["source"]["kind"] == "local_sqlite"
    assert catalog["summary"]["tableCount"] == 2
    assert catalog["summary"]["rawJsonFieldCount"] >= 5
    assert catalog["summary"]["udfFieldCount"] >= 4

    fields_by_id = {field["id"]: field for field in catalog["fields"]}
    team_field = fields_by_id["octane_defects.raw_json.problem_finder_team_udf"]
    assert team_field["entity"] == "defect"
    assert team_field["udf"] is True
    assert team_field["localColumn"] == "problem_finder_team"
    assert team_field["businessBucket"] == "ownership"
    assert team_field["observedRows"] == 2
    assert team_field["populatedRows"] == 2
    assert team_field["populatedRate"] == 1.0
    assert "DTSV" in team_field["semanticAliases"]

    model_field = fields_by_id["octane_defects.raw_json.model_series_udf"]
    assert model_field["localColumn"] == "model_series"
    assert model_field["businessBucket"] == "product_vehicle"

    empty_field = fields_by_id["octane_defects.raw_json.unused_empty_udf"]
    assert empty_field["populatedRows"] == 0
    assert empty_field["ontologyStatus"] == "raw"

    rare_field = fields_by_id["octane_defects.raw_json.rare_business_udf"]
    assert rare_field["observedRows"] == 2
    assert rare_field["populatedRows"] == 1
    assert rare_field["populatedRate"] == 0.5

    draft_ids = {candidate["fieldId"] for candidate in catalog["ontologyDraft"]["fieldCandidates"]}
    assert "octane_defects.raw_json.problem_finder_team_udf" in draft_ids
    assert "octane_defects.raw_json.unused_empty_udf" not in draft_ids


def test_search_octane_fields_returns_small_relevant_field_set(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    _seed_octane_db(db_path)
    catalog = build_local_octane_field_catalog(db_path=db_path, sample_limit=100)

    results = search_octane_fields(catalog, "DTSV 最近一季度哪个车系 defect 上升最快", top_k=3)

    assert len(results) <= 3
    result_ids = [result["id"] for result in results]
    assert "octane_defects.raw_json.problem_finder_team_udf" in result_ids
    assert "octane_defects.raw_json.model_series_udf" in result_ids
    assert all("score" in result and result["score"] > 0 for result in results)


def test_build_octane_field_catalog_cli_writes_catalog_and_search_preview(tmp_path: Path, capsys) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "octane-field-catalog.json"
    _seed_octane_db(db_path)

    exit_code = main([
        "build-octane-field-catalog",
        "--db-path",
        str(db_path),
        "--output-path",
        str(output_path),
        "--query-text",
        "DTSV 车系",
        "--top-k",
        "2",
    ])

    assert exit_code == 0
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["summary"]["tableCount"] == 2
    stdout = json.loads(capsys.readouterr().out)
    assert stdout["output_path"] == str(output_path)
    assert stdout["summary"]["fieldCount"] == payload["summary"]["fieldCount"]
    assert len(stdout["search_preview"]) == 2


def test_load_local_octane_field_catalog_uses_generated_artifact(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "octane-field-catalog.json"
    _seed_octane_db(db_path)
    catalog = build_local_octane_field_catalog(db_path=db_path, sample_limit=100)
    output_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
    db_path.unlink()
    reset_octane_field_catalog_cache()
    monkeypatch.setenv("VIZION_OCTANE_FIELD_CATALOG_PATH", str(output_path))

    loaded = load_local_octane_field_catalog()

    assert loaded["summary"] == catalog["summary"]
    assert search_octane_fields(loaded, "DTSV 车系", top_k=2)


def test_octane_field_search_api_returns_top_k_without_full_catalog(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "qgate_raw.db"
    _seed_octane_db(db_path)
    monkeypatch.setenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", str(db_path))
    client = TestClient(app)

    response = client.post("/api/ontology/fields/search", json={"query": "DTSV 车系", "top_k": 2})

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["tableCount"] == 2
    assert len(payload["results"]) == 2
    assert {item["id"] for item in payload["results"]} == {
        "octane_defects.raw_json.problem_finder_team_udf",
        "octane_defects.raw_json.model_series_udf",
    }
    assert "fields" not in payload