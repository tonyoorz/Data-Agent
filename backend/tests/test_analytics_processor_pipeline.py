from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from backend.analytics.processor import run_processor_pipeline


def test_run_processor_pipeline_replaces_unknown_defect_project_with_derived_value(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir(parents=True)
    (asset_root / "top_aida_project_fv_mapping.json").write_text(
        json.dumps(
            [
                {
                    "top_aida": "Use Speech operation [01.04.02.01.01.05]",
                    "project": "IDCEVO",
                    "fv": "Speech",
                    "fvp": "Voice Experience",
                }
            ]
        ),
        encoding="utf-8",
    )
    (asset_root / "vin_project_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "mr_nonstandard_platform_ids.json").write_text(json.dumps([]), encoding="utf-8")

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                product_areas TEXT,
                solution_cluster TEXT,
                ecu_to_modul TEXT,
                function_responsible TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO octane_defects(defect_id, project, top_aida, assigned_ecu, software_version, lead_model, product_areas, solution_cluster, ecu_to_modul, function_responsible, market, pu, fv, fvp, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "D-UNKNOWN-PROJECT",
                "Unknown",
                "Use Speech operation [01.04.02.01.01.05]",
                "",
                "",
                "NA5",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path, asset_root=asset_root)

    assert summary["defect_updates"] == 1

    conn = sqlite3.connect(db_path)
    try:
        project = conn.execute(
            "SELECT project FROM octane_defects WHERE defect_id='D-UNKNOWN-PROJECT'"
        ).fetchone()[0]
    finally:
        conn.close()

    assert project == "IDCEVO"


def test_run_processor_pipeline_replaces_unknown_manual_run_project_with_derived_value(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir(parents=True)
    (asset_root / "top_aida_project_fv_mapping.json").write_text(
        json.dumps(
            [
                {
                    "top_aida": "Use Speech operation [01.04.02.01.01.05]",
                    "project": "",
                    "fv": "Speech",
                    "fvp": "Voice Experience",
                }
            ]
        ),
        encoding="utf-8",
    )
    (asset_root / "vin_project_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "mr_nonstandard_platform_ids.json").write_text(json.dumps([]), encoding="utf-8")

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                top_aida TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                product_areas TEXT,
                solution_cluster TEXT,
                ecu_to_modul TEXT,
                function_responsible TEXT,
                market TEXT,
                team TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                test_week TEXT,
                pu TEXT,
                top_aida TEXT,
                tester TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, test_week, pu, top_aida, tester, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "MR-UNKNOWN-PROJECT",
                "",
                "T-UNKNOWN-PROJECT",
                "Wake test unknown project",
                "Passed",
                "2026",
                "",
                "",
                "",
                "",
                "Unknown",
                "",
                "",
                "",
                "",
                json.dumps(
                    {
                        "name": "0726_FA Visualization IDCEVO run",
                        "target_ecu_conf_udf": "IDCEVO-25 and ICON-25",
                        "product_areas": {
                            "total_count": 1,
                            "data": [
                                {"name": "Use Speech operation [01.04.02.01.01.05]"}
                            ],
                        },
                    },
                    ensure_ascii=False,
                ),
                "2026-03-11T08:31:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path, asset_root=asset_root)

    assert summary["run_updates"] == 1

    conn = sqlite3.connect(db_path)
    try:
        project = conn.execute(
            "SELECT project FROM octane_manual_runs WHERE mr_id='MR-UNKNOWN-PROJECT'"
        ).fetchone()[0]
    finally:
        conn.close()

    assert project == "IDCEVO"


def test_run_processor_pipeline_can_scope_manual_run_updates(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir(parents=True)
    (asset_root / "top_aida_project_fv_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "vin_project_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "mr_nonstandard_platform_ids.json").write_text(json.dumps([]), encoding="utf-8")

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                top_aida TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                product_areas TEXT,
                solution_cluster TEXT,
                ecu_to_modul TEXT,
                function_responsible TEXT,
                market TEXT,
                team TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                year TEXT,
                test_week TEXT,
                pu TEXT,
                top_aida TEXT,
                tester TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.executemany(
            "INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, test_week, pu, top_aida, tester, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    "MR-IN-SCOPE",
                    "",
                    "T-1",
                    "Scoped run",
                    "Passed",
                    "2026",
                    "",
                    "",
                    "",
                    "",
                    "Unknown",
                    "",
                    "",
                    "",
                    "",
                    json.dumps({"name": "IDCEVO scoped run", "target_ecu_conf_udf": "IDCEVO-25"}),
                    "2026-03-11T08:31:00Z",
                ),
                (
                    "MR-OUT-OF-SCOPE",
                    "",
                    "T-2",
                    "Unscoped run",
                    "Passed",
                    "2026",
                    "",
                    "",
                    "",
                    "",
                    "Unknown",
                    "",
                    "",
                    "",
                    "",
                    json.dumps({"name": "IDCEVO unscoped run", "target_ecu_conf_udf": "IDCEVO-25"}),
                    "2026-03-11T08:31:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path, asset_root=asset_root, manual_run_ids=("MR-IN-SCOPE",))

    assert summary["run_updates"] == 1

    conn = sqlite3.connect(db_path)
    try:
        rows = dict(conn.execute("SELECT mr_id, project FROM octane_manual_runs ORDER BY mr_id").fetchall())
    finally:
        conn.close()

    assert rows == {"MR-IN-SCOPE": "IDCEVO", "MR-OUT-OF-SCOPE": "Unknown"}


def test_run_processor_pipeline_dry_run_does_not_report_unknown_project_as_fillable(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    asset_root = tmp_path / "assets"
    report_path = tmp_path / "processor_dimension_diff.json"
    asset_root.mkdir(parents=True)
    (asset_root / "top_aida_project_fv_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "vin_project_mapping.json").write_text(json.dumps([]), encoding="utf-8")
    (asset_root / "mr_nonstandard_platform_ids.json").write_text(json.dumps([]), encoding="utf-8")

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                product_areas TEXT,
                solution_cluster TEXT,
                ecu_to_modul TEXT,
                function_responsible TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT
            );
            CREATE TABLE octane_manual_runs (
                mr_id TEXT PRIMARY KEY,
                defect_id TEXT,
                test_id TEXT,
                test_name TEXT,
                status TEXT,
                project TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT,
                fetched_at TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO octane_defects(defect_id, project, top_aida, assigned_ecu, software_version, lead_model, product_areas, solution_cluster, ecu_to_modul, function_responsible, market, pu, fv, fvp, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-UNKNOWN-FILLABLE", "", "", "", "", "G70", "", "", "", "", "", "", "", "", ""),
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path, asset_root=asset_root, dry_run=True, report_path=report_path)

    assert summary["fillable_rows"] == 0
    assert summary["conflict_rows"] == 0

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["fillable_rows"] == []
    assert report["conflict_rows"] == []