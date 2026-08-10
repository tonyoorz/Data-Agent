import sqlite3
import json

from backend.analytics.ingest.source_store import OctaneSourceStore
from backend.analytics.processor import backfill_defect_projects, run_processor_pipeline, sync_dimension_fields
from backend.analytics.schema import ensure_schema


def test_sync_dimension_fields_backfills_defects_and_runs(tmp_path):
    db_path = tmp_path / "octane_data.db"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO octane_defects(defect_id, name, project, market, pu, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("D-1", "Wake issue", "", "", "", "", "", "", "", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, project, fv, fvp, team, lead_model, raw_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("MR-1", "D-1", "T-1", "Wake test", "Passed", "", "", "", "", "", "{}", "2026-05-25T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    sync_dimension_fields(
        db_path,
        defect_dimension_rows=[
            {
                "id": "D-1",
                "project": "IDCEVO",
                "market": "CN",
                "pu": "PU1",
                "fv": "Speech",
                "fvp": "Tony",
                "team": "DTSV_China",
                "lead_model": "NA5",
            }
        ],
        run_dimension_rows=[
            {
                "id": "MR-1",
                "project": "IDCEVO",
                "fv": "Speech",
                "fvp": "Tony",
                "team": "DTSV_China",
                "lead_model": "NA5",
            }
        ],
    )

    conn = sqlite3.connect(db_path)
    try:
        defect = conn.execute(
            "SELECT project, market, pu, fv, fvp, team, lead_model FROM octane_defects WHERE defect_id='D-1'"
        ).fetchone()
        run = conn.execute(
            "SELECT project, fv, fvp, team, lead_model FROM octane_manual_runs WHERE mr_id='MR-1'"
        ).fetchone()
    finally:
        conn.close()

    assert defect == ("IDCEVO", "CN", "PU1", "Speech", "Tony", "DTSV_China", "NA5")
    assert run == ("IDCEVO", "Speech", "Tony", "DTSV_China", "NA5")


def test_run_processor_pipeline_backfills_defect_pu_from_first_use_sop(tmp_path):
    db_path = tmp_path / "qgate_raw.db"
    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model,
                top_aida, first_use_sop_of_function, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-PU-1",
                "PU issue",
                "IDCEVO",
                "",
                "",
                "",
                "",
                "DTSV_China",
                "NA5",
                "Use Speech operation [01.04.02.01.01.05]",
                "PU-27",
                "{}",
                "2026-06-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path)

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT pu FROM octane_defects WHERE defect_id='D-PU-1'").fetchone()
    finally:
        conn.close()

    assert summary["defect_updates"] == 1
    assert row == ("PU-27",)


def test_run_processor_pipeline_backfills_defect_market_from_vin_mapping(tmp_path):
    db_path = tmp_path / "qgate_raw.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    (asset_root / "top_aida_project_fv_mapping.json").write_text("[]", encoding="utf-8")
    (asset_root / "mr_nonstandard_platform_ids.json").write_text("[]", encoding="utf-8")
    (asset_root / "vin_project_mapping.json").write_text(
        json.dumps([
            {"vin_prefix": "VIN-CN", "project": "IDCEVO", "market": "CN"},
        ]),
        encoding="utf-8",
    )

    store = OctaneSourceStore(db_path)
    try:
        store.create_tables()
    finally:
        store.close()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, name, project, market, pu, fv, fvp, team, lead_model,
                vin, raw_json, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-MARKET-1",
                "Market issue",
                "IDCEVO",
                "",
                "PU-27",
                "",
                "",
                "DTSV_China",
                "NA5",
                "VIN-CN-12345",
                "{}",
                "2026-06-25T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    summary = run_processor_pipeline(db_path, asset_root=asset_root)

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT market FROM octane_defects WHERE defect_id='D-MARKET-1'").fetchone()
    finally:
        conn.close()

    assert summary["defect_updates"] == 1
    assert row == ("CN",)


def test_backfill_defect_projects_updates_unknown_rows_from_signals(tmp_path):
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                tproject TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id, project, tproject, top_aida, assigned_ecu, software_version, lead_model
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-IDC", "Unknown", "Unknown", "", "HU-MGU_02_A", "", "G48"),
                ("D-IDCEVO", "Unknown", "Unknown", "", "IDCEVO-25", "", "NA8"),
                ("D-MGU", "Unknown", "Unknown", "", "", "BMWMGU22;MGU22_25w36.3-1-2;mgu22", ""),
                ("D-RSU", "Unknown", "Unknown", "Use Rear Seat Entertainment [01.04.01.09.02]", "", "", ""),
                ("D-APP", "Unknown", "Unknown", "", "APP_Mobile_2_0_Android_CN", "", ""),
                ("D-LEAD", "Unknown", "Unknown", "", "", "", "U12"),
                ("D-KEEP", "MGU", "MGU", "", "HU-MGU_02_A", "", "G48"),
                ("D-UNKNOWN", "Unknown", "Unknown", "", "", "", "G70"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = backfill_defect_projects(db_path, apply=True)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT defect_id, project, tproject FROM octane_defects ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    assert summary["updated_rows"] == 6
    assert summary["candidate_rows"] == 7
    assert summary["predicted_counts"] == {
        "App": 1,
        "IDC": 2,
        "IDCEVO": 1,
        "MGU": 1,
        "RSU": 1,
        "Unknown": 1,
    }
    assert rows == [
        ("D-APP", "App", "App"),
        ("D-IDC", "IDC", "IDC"),
        ("D-IDCEVO", "IDCEVO", "IDCEVO"),
        ("D-KEEP", "MGU", "MGU"),
        ("D-LEAD", "IDC", "IDC"),
        ("D-MGU", "MGU", "MGU"),
        ("D-RSU", "RSU", "RSU"),
        ("D-UNKNOWN", "Unknown", "Unknown"),
    ]


def test_backfill_defect_projects_dry_run_does_not_modify_database(tmp_path):
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                top_aida TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(
                defect_id, project, assigned_ecu, software_version, lead_model, top_aida
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("D-1", "Unknown", "HU-MGU_02_A", "", "", ""),
        )
        conn.commit()
    finally:
        conn.close()

    summary = backfill_defect_projects(db_path, apply=False)

    conn = sqlite3.connect(db_path)
    try:
        project = conn.execute(
            "SELECT project FROM octane_defects WHERE defect_id='D-1'"
        ).fetchone()[0]
    finally:
        conn.close()

    assert summary["updated_rows"] == 0
    assert summary["candidate_rows"] == 1
    assert summary["predicted_counts"] == {"IDC": 1}
    assert project == "Unknown"


def test_backfill_defect_projects_uses_conservative_second_pass_rules(tmp_path):
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                tproject TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                product_areas TEXT,
                solution_cluster TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id,
                project,
                tproject,
                top_aida,
                assigned_ecu,
                software_version,
                lead_model,
                product_areas,
                solution_cluster
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-G58", "Unknown", "Unknown", "", "", "", "G58", "", ""),
                ("D-NA8", "Unknown", "Unknown", "", "", "", "NA8", "", ""),
                ("D-U11", "Unknown", "Unknown", "", "", "", "U11", "", ""),
                ("D-G18", "Unknown", "Unknown", "", "", "", "G18", "", ""),
                ("D-IPN15", "Unknown", "Unknown", "", "IPN-15", "", "", "", ""),
                ("D-UCAP10", "Unknown", "Unknown", "", "UCAP-10", "", "", "", ""),
                (
                    "D-SPEECH",
                    "Unknown",
                    "Unknown",
                    "Use Speech operation [01.04.02.01.01.05]",
                    "",
                    "",
                    "G78",
                    "",
                    "",
                ),
                (
                    "D-PRODUCT",
                    "Unknown",
                    "Unknown",
                    "",
                    "",
                    "",
                    "",
                    "Provide Navigation 2.0 [01.04.03.01.03.06]",
                    "",
                ),
                ("D-CLUSTER", "Unknown", "Unknown", "", "", "", "", "", "Navigation Asia"),
                ("D-G78", "Unknown", "Unknown", "", "", "", "G78", "", ""),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = backfill_defect_projects(db_path, apply=True)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT defect_id, project, tproject FROM octane_defects ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    assert summary["updated_rows"] == 9
    assert summary["candidate_rows"] == 10
    assert summary["predicted_counts"] == {
        "IDC": 1,
        "IDCEVO": 5,
        "MGU": 3,
        "Unknown": 1,
    }
    assert rows == [
        ("D-CLUSTER", "MGU", "MGU"),
        ("D-G18", "MGU", "MGU"),
        ("D-G58", "IDCEVO", "IDCEVO"),
        ("D-G78", "Unknown", "Unknown"),
        ("D-IPN15", "IDCEVO", "IDCEVO"),
        ("D-NA8", "IDCEVO", "IDCEVO"),
        ("D-PRODUCT", "IDCEVO", "IDCEVO"),
        ("D-SPEECH", "IDCEVO", "IDCEVO"),
        ("D-U11", "IDC", "IDC"),
        ("D-UCAP10", "MGU", "MGU"),
    ]


def test_backfill_defect_projects_uses_ecu_module_and_function_responsible_rules(tmp_path):
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                tproject TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT,
                ecu_to_modul TEXT,
                function_responsible TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id,
                project,
                tproject,
                top_aida,
                assigned_ecu,
                software_version,
                lead_model,
                ecu_to_modul,
                function_responsible
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-G78-KH", "Unknown", "Unknown", "", "SHM-08", "", "G78", "KH", ""),
                ("D-G78-CC", "Unknown", "Unknown", "", "IPB-01", "", "G78", "CC", ""),
                ("D-G70-FH", "Unknown", "Unknown", "", "IPB-01", "", "G70", "FH", ""),
                ("D-G68-FH", "Unknown", "Unknown", "", "BCP-21", "", "G68", "FH", ""),
                ("D-G68-CC", "Unknown", "Unknown", "", "BCP-21", "", "G68", "CC", ""),
                ("D-G70-FUNC-1", "Unknown", "Unknown", "", "MARS-01", "", "G70", "", "Rainer Funke"),
                (
                    "D-G70-FUNC-2",
                    "Unknown",
                    "Unknown",
                    "",
                    "IPF-01_DAF",
                    "",
                    "G70",
                    "",
                    "Marijke Brinkmann",
                ),
                ("D-G78-KEEP", "Unknown", "Unknown", "", "IPB-01", "", "G78", "", ""),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = backfill_defect_projects(db_path, apply=True)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT defect_id, project, tproject FROM octane_defects ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    assert summary["updated_rows"] == 7
    assert summary["candidate_rows"] == 8
    assert summary["predicted_counts"] == {
        "IDCEVO": 3,
        "MGU": 4,
        "Unknown": 1,
    }
    assert rows == [
        ("D-G68-CC", "MGU", "MGU"),
        ("D-G68-FH", "MGU", "MGU"),
        ("D-G70-FH", "IDCEVO", "IDCEVO"),
        ("D-G70-FUNC-1", "IDCEVO", "IDCEVO"),
        ("D-G70-FUNC-2", "IDCEVO", "IDCEVO"),
        ("D-G78-CC", "MGU", "MGU"),
        ("D-G78-KEEP", "Unknown", "Unknown"),
        ("D-G78-KH", "MGU", "MGU"),
    ]


def test_backfill_defect_projects_uses_conservative_software_version_tokens(tmp_path):
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                project TEXT,
                tproject TEXT,
                top_aida TEXT,
                assigned_ecu TEXT,
                software_version TEXT,
                lead_model TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id,
                project,
                tproject,
                top_aida,
                assigned_ecu,
                software_version,
                lead_model
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-CDE", "Unknown", "Unknown", "", "", "BMW CDE;2607_i460-25w50.2-2;cde", ""),
                ("D-IDC23", "Unknown", "Unknown", "", "", "bmw_idc23-mainline-24w49.5-1", ""),
                ("D-MGU22", "Unknown", "Unknown", "", "", "BMW MGU22;MGU22_24w50.4-1-5;mgu22", ""),
                ("D-RSE26", "Unknown", "Unknown", "", "", "nightly/rse26-mainline/25w50.7-1", ""),
                ("D-MIXED", "Unknown", "Unknown", "", "", "nightly/idcevo/rse26-mainline/25w50.7-1", ""),
                ("D-AMB", "Unknown", "Unknown", "", "", "mainline24w49.5-1", ""),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    summary = backfill_defect_projects(db_path, apply=True)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT defect_id, project, tproject FROM octane_defects ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    assert summary["updated_rows"] == 5
    assert summary["candidate_rows"] == 6
    assert summary["predicted_counts"] == {
        "IDC": 1,
        "IDCEVO": 2,
        "MGU": 1,
        "RSU": 1,
        "Unknown": 1,
    }
    assert rows == [
        ("D-AMB", "Unknown", "Unknown"),
        ("D-CDE", "IDCEVO", "IDCEVO"),
        ("D-IDC23", "IDC", "IDC"),
        ("D-MGU22", "MGU", "MGU"),
        ("D-MIXED", "IDCEVO", "IDCEVO"),
        ("D-RSE26", "RSU", "RSU"),
    ]