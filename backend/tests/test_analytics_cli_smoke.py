from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path

import backend.analytics_cli as analytics_cli
from backend.analytics_cli import main
from backend.analytics.ingest import client as ingest_client
from backend.analytics.ingest import pipeline as ingest_pipeline


def test_analytics_cli_init_db_command_creates_database(tmp_path: Path) -> None:
    db_path = tmp_path / "octane_data.db"
    repo_root = Path(__file__).resolve().parents[2]

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.analytics_cli",
            "init-db",
            "--db-path",
            str(db_path),
        ],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert db_path.exists()

    conn = sqlite3.connect(db_path)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    finally:
        conn.close()

    assert "octane_defects" in tables
    assert "octane_manual_runs" in tables
    assert "octane_testcases" in tables


def test_analytics_cli_refresh_octane_source_invokes_repo_owned_pipeline(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    captured: dict[str, object] = {}

    def fake_build_default_octane_client() -> str:
        return "fake-client"

    def fake_refresh_octane_source(*, request, client) -> dict[str, int]:
        captured["request"] = request
        captured["client"] = client
        return {
            "defect_rows": 1,
            "history_event_rows": 2,
            "manual_run_rows": 3,
            "testcase_rows": 4,
            "testcase_relation_rows": 5,
        }

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None) -> dict[str, int]:
        captured["processor"] = {
            "db_path": db_path,
            "asset_root": asset_root,
            "dry_run": dry_run,
            "report_path": report_path,
        }
        return {"defect_updates": 6, "run_updates": 7}

    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_source", fake_refresh_octane_source)
    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)

    exit_code = main([
        "refresh-octane-source",
        "--teams",
        "all",
        "--years",
        "2026",
        "--skip-comments",
    ])

    stdout = capsys.readouterr().out
    request = captured["request"]
    processor_call = captured["processor"]

    assert exit_code == 0
    assert captured["client"] == "fake-client"
    assert request.source_db_path == database_root / "source" / "qgate_raw.db"
    assert request.teams == ("all",)
    assert request.years == (2026,)
    assert request.include_history is True
    assert request.include_comments is False
    assert request.include_testing is True
    assert processor_call["db_path"] == request.source_db_path
    assert processor_call["dry_run"] is False
    assert '"testcase_relation_rows": 5' in stdout
    assert '"defect_updates": 6' in stdout
    assert '"run_updates": 7' in stdout


def test_analytics_cli_audit_octane_dimensions_writes_report_under_hot_database(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    captured: dict[str, object] = {}

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None) -> dict[str, int]:
        captured["db_path"] = db_path
        captured["asset_root"] = asset_root
        captured["dry_run"] = dry_run
        captured["report_path"] = report_path
        return {
            "defect_updates": 0,
            "run_updates": 0,
            "fillable_rows": 11,
            "conflict_rows": 22,
        }

    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)

    exit_code = main(["audit-octane-dimensions"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["db_path"] == database_root / "source" / "qgate_raw.db"
    assert captured["dry_run"] is True
    assert captured["report_path"] == database_root / "hot" / "processor_dimension_diff.json"
    assert '"fillable_rows": 11' in stdout
    assert '"conflict_rows": 22' in stdout