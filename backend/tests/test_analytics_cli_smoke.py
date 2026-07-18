from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import backend.analytics_cli as analytics_cli
from backend.analytics_cli import main
from backend.analytics.dashboard_snapshot import read_active_snapshot_state
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


def test_analytics_cli_generate_qgate_kpi_reports_invokes_native_generators(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_root = tmp_path / "qgate-reports"
    dashboard_path = output_root / "20260611_120000" / "qgate_kpi_dashboard_20260611_120000.html"
    compare_path = output_root / "20260611_120000" / "qgate_kpi_compare_2025_2026_20260611_120000.html"
    captured: dict[str, object] = {}

    def fake_build_timestamped_output_paths(root, file_names):
        captured["output_root"] = root
        captured["file_names"] = file_names
        return dashboard_path, compare_path

    def fake_generate_dashboard_report(*, db_path, output_path):
        captured["dashboard"] = {"db_path": db_path, "output_path": output_path}
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_text("dashboard", encoding="utf-8")
        return Path(output_path)

    def fake_generate_compare_report(*, db_path, output_path, years):
        captured["compare"] = {"db_path": db_path, "output_path": output_path, "years": years}
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_text("compare", encoding="utf-8")
        return Path(output_path)

    monkeypatch.setattr(analytics_cli, "build_timestamped_output_paths", fake_build_timestamped_output_paths, raising=False)
    monkeypatch.setattr(analytics_cli, "generate_qgate_kpi_dashboard_report", fake_generate_dashboard_report, raising=False)
    monkeypatch.setattr(analytics_cli, "generate_qgate_kpi_compare_report", fake_generate_compare_report, raising=False)

    exit_code = main([
        "generate-qgate-kpi-reports",
        "--db-path",
        str(db_path),
        "--output-root",
        str(output_root),
        "--years",
        "2025,2026",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["output_root"] == str(output_root)
    assert "qgate_kpi_dashboard_{stamp}.html" in captured["file_names"]
    assert "qgate_kpi_compare_2025_2026_{stamp}.html" in captured["file_names"]
    assert captured["dashboard"] == {"db_path": db_path, "output_path": dashboard_path}
    assert captured["compare"] == {"db_path": db_path, "output_path": compare_path, "years": ("2025", "2026")}
    assert "qgate_kpi_dashboard_20260611_120000.html" in stdout
    assert "qgate_kpi_compare_2025_2026_20260611_120000.html" in stdout


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


def test_analytics_cli_refresh_manual_runs_source_invokes_repo_owned_pipeline(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    captured: dict[str, object] = {}

    def fake_build_default_octane_client() -> str:
        return "fake-client"

    def fake_refresh_octane_manual_runs_only(*, source_db_path, team_name, years, client, progress=None) -> dict[str, int]:
        captured["pipeline"] = {
            "source_db_path": source_db_path,
            "team_name": team_name,
            "years": years,
            "client": client,
        }
        if progress is not None:
            progress("Refreshing manual runs for DTSV_China 2025 with full fetch")
        return {"manual_run_rows": 3}

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None, manual_run_ids=None) -> dict[str, int]:
        captured["processor"] = {
            "db_path": db_path,
            "asset_root": asset_root,
            "dry_run": dry_run,
            "report_path": report_path,
            "manual_run_ids": manual_run_ids,
        }
        return {"defect_updates": 0, "run_updates": 5}

    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_manual_runs_only", fake_refresh_octane_manual_runs_only)
    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)

    exit_code = main([
        "refresh-manual-runs-source",
        "--team-name",
        "DTSV_China",
        "--years",
        "2025,2026",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["pipeline"] == {
        "source_db_path": database_root / "source" / "qgate_raw.db",
        "team_name": "DTSV_China",
        "years": (2025, 2026),
        "client": "fake-client",
    }
    assert captured["processor"] == {
        "db_path": database_root / "source" / "qgate_raw.db",
        "asset_root": None,
        "dry_run": False,
        "report_path": None,
        "manual_run_ids": None,
    }
    assert "Starting manual-runs refresh for DTSV_China years=2025,2026" in stdout
    assert "Refreshing manual runs for DTSV_China 2025 with full fetch" in stdout
    assert "Running processor pipeline..." in stdout
    assert "Processor pipeline finished" in stdout
    assert '"manual_run_rows": 3' in stdout
    assert '"run_updates": 5' in stdout


def test_analytics_cli_refresh_traceability_source_invokes_repo_owned_pipeline(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    captured: dict[str, object] = {}

    def fake_build_default_octane_client() -> str:
        return "fake-client"

    def fake_refresh_octane_traceability_source(
        *, source_db_path, team_name, years, releases, force, workers, client, progress=None
    ) -> dict[str, object]:
        captured["pipeline"] = {
            "source_db_path": source_db_path,
            "team_name": team_name,
            "years": years,
            "releases": releases,
            "force": force,
            "workers": workers,
            "client": client,
        }
        if progress is not None:
            progress("Refreshing traceability runs for DTSV_China 2026 with full fetch")
        return {"manual_run_rows": 4, "traceability_rows": 9, "manual_run_ids": ["MR-1"]}

    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_traceability_source", fake_refresh_octane_traceability_source)

    exit_code = main([
        "refresh-traceability-source",
        "--team-name",
        "DTSV_China",
        "--years",
        "2026",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["pipeline"] == {
        "source_db_path": database_root / "source" / "qgate_raw.db",
        "team_name": "DTSV_China",
        "years": (2026,),
        "releases": (),
        "force": False,
        "workers": 24,
        "client": "fake-client",
    }
    assert "Starting traceability refresh for DTSV_China years=2026" in stdout
    assert "Refreshing traceability runs for DTSV_China 2026 with full fetch" in stdout
    assert "Traceability refresh finished" in stdout
    assert '"traceability_rows": 9' in stdout


def test_analytics_cli_refresh_octane_cookie_validates_refreshed_cookie(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(tmp_path))
    calls: list[tuple[str, object]] = []

    def fake_refresh_cookie_file(*, base_url, cookie_file, headless):
        calls.append(("refresh", {"base_url": base_url, "cookie_file": cookie_file, "headless": headless}))
        Path(cookie_file).write_text("SESSION=valid", encoding="utf-8")

    class FakeClient:
        def list_teams(self):
            calls.append(("validate", None))
            return [{"id": "1", "name": "DTSV_China"}]

    monkeypatch.setattr(analytics_cli, "refresh_cookie_file", fake_refresh_cookie_file)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", lambda: FakeClient())

    exit_code = main(["refresh-octane-cookie", "--headless"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert [name for name, _ in calls] == ["refresh", "validate"]
    assert calls[0][1]["headless"] is True
    assert '"cookie_validated": true' in stdout


def test_analytics_cli_refresh_octane_cookie_can_update_cookie_file_in_place(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(tmp_path))
    calls: list[tuple[str, object]] = []

    def fake_refresh_cookie_file(*, base_url, cookie_file, headless):
        calls.append(("refresh", {"cookie_file": cookie_file, "headless": headless}))
        Path(cookie_file).write_text("SESSION=valid", encoding="utf-8")

    class FakeClient:
        def list_teams(self):
            calls.append(("validate", None))
            return [{"id": "1", "name": "DTSV_China"}]

    monkeypatch.setattr(analytics_cli, "refresh_cookie_file", fake_refresh_cookie_file)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", lambda: FakeClient())

    exit_code = main(["refresh-octane-cookie", "--in-place"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert [name for name, _ in calls] == ["refresh", "validate"]
    assert Path(calls[0][1]["cookie_file"]).name == "cookie.txt"
    assert '"mode": "local-playwright-in-place"' in stdout
    assert '"candidate_cookie_file"' not in stdout


def test_analytics_cli_refresh_octane_cookie_fails_when_refreshed_cookie_is_invalid(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(tmp_path))

    def fake_refresh_cookie_file(*, base_url, cookie_file, headless):
        Path(cookie_file).write_text("SESSION=invalid", encoding="utf-8")

    class FakeClient:
        def list_teams(self):
            raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(analytics_cli, "refresh_cookie_file", fake_refresh_cookie_file)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", lambda: FakeClient())

    exit_code = main(["refresh-octane-cookie", "--headless"])

    stdout = capsys.readouterr().out
    assert exit_code == 1
    assert '"cookie_validated": false' in stdout
    assert "401 Unauthorized" in stdout


def test_analytics_cli_refresh_full_picture_outcomes_reports_progress(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    source_db = tmp_path / "history.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            "CREATE TABLE octane_defect_history_events (defect_id TEXT, field_name TEXT, event_timestamp TEXT)"
        )
        conn.commit()
    finally:
        conn.close()

    def fake_refresh(source_db_path, hot_db_path, force, defect_ids=None):
        return {"row_count": 12, "skipped": False, "source_signature": "sig-1"}

    monkeypatch.setattr(analytics_cli, "refresh_materialized_outcomes", fake_refresh)
    monkeypatch.setattr(analytics_cli, "record_snapshot_refresh", lambda *args, **kwargs: None)
    monkeypatch.setattr(analytics_cli, "activate_snapshot_version", lambda *args, **kwargs: None)
    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert "Starting full-picture outcomes refresh" in stdout
    assert "Deriving hot outcomes from" in stdout
    assert "Recording dashboard snapshot metadata..." in stdout
    assert "Full-picture outcomes refresh finished" in stdout
    assert '"row_count": 12' in stdout


def test_analytics_cli_refresh_all_sources_runs_steps_in_order(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    source_db_path.touch()
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    calls: list[tuple[str, object]] = []

    def fake_refresh_octane_source(*, request, client):
        calls.append(("source", {"request": request, "client": client}))
        return {"defect_rows": 3, "defect_ids": ["D-1", "D-2"], "history_event_rows": 4}

    def fake_build_default_octane_client() -> str:
        calls.append(("build_client", None))
        return "fake-client"

    def fake_refresh_octane_manual_runs_only(*, source_db_path, team_name, years, client, progress=None):
        calls.append(("manual_runs", {
            "source_db_path": source_db_path,
            "team_name": team_name,
            "years": years,
            "client": client,
        }))
        if progress is not None:
            progress("manual progress line")
        return {"manual_run_rows": 7}

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None, manual_run_ids=None):
        calls.append(("processor", {
            "db_path": db_path,
            "asset_root": asset_root,
            "dry_run": dry_run,
            "report_path": report_path,
            "manual_run_ids": manual_run_ids,
        }))
        return {"defect_updates": 2, "run_updates": 3}

    def fake_refresh_materialized_outcomes(source_db_path, hot_db_path, force, defect_ids=None):
        calls.append(("outcomes", {
            "source_db_path": source_db_path,
            "hot_db_path": hot_db_path,
            "force": force,
            "defect_ids": defect_ids,
        }))
        return {"row_count": 11, "skipped": False, "source_signature": "sig-2"}

    monkeypatch.setattr(ingest_pipeline, "refresh_octane_source", fake_refresh_octane_source)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_manual_runs_only", fake_refresh_octane_manual_runs_only)
    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)
    monkeypatch.setattr(analytics_cli, "refresh_materialized_outcomes", fake_refresh_materialized_outcomes)
    monkeypatch.setattr(analytics_cli, "record_snapshot_refresh", lambda *args, **kwargs: None)
    monkeypatch.setattr(analytics_cli, "activate_snapshot_version", lambda *args, **kwargs: None)

    exit_code = main([
        "refresh-all-sources",
        "--teams",
        "DTSV_China,[AT]CoC_EI_IuK",
        "--years",
        "2025,2026",
        "--team-name",
        "DTSV_China",
        "--manual-years",
        "2026",
        "--history-max-workers",
        "50",
        "--team-max-workers",
        "2",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert [name for name, _ in calls] == [
        "build_client",
        "source",
        "build_client",
        "manual_runs",
        "processor",
        "outcomes",
    ]
    assert "Starting combined source refresh" in stdout
    assert "Step 1/3: refreshing Octane defects and history source..." in stdout
    assert "Step 1/3 summary: defect_rows=3 history_event_rows=4" in stdout
    assert "Step 2/3: refreshing manual runs source..." in stdout
    assert "manual progress line" in stdout
    assert "Step 3/3: refreshing full-picture outcomes..." in stdout
    assert '"manual_run_rows": 7' in stdout
    assert '"row_count": 11' in stdout
    assert calls[1][1]["request"].years == (2025, 2026)
    assert calls[1][1]["request"].include_history is True
    assert calls[1][1]["request"].team_max_workers == 2
    assert calls[3][1]["years"] == (2026,)
    assert calls[4][1]["manual_run_ids"] is None
    assert calls[5][1]["defect_ids"] == ("D-1", "D-2")


def test_analytics_cli_refresh_all_sources_defaults_to_2025_through_current_testing_year(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    source_db_path = database_root / "source" / "qgate_raw.db"
    source_db_path.parent.mkdir(parents=True, exist_ok=True)
    source_db_path.touch()
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))

    calls: list[tuple[str, object]] = []

    def fake_refresh_octane_source(*, request, client):
        calls.append(("source", {"request": request, "client": client}))
        return {"defect_rows": 0, "defect_ids": [], "history_event_rows": 0}

    def fake_build_default_octane_client() -> str:
        calls.append(("build_client", None))
        return "fake-client"

    def fake_refresh_octane_manual_runs_only(*, source_db_path, team_name, years, client, progress=None):
        calls.append(("manual_runs", {
            "source_db_path": source_db_path,
            "team_name": team_name,
            "years": years,
            "client": client,
        }))
        return {"manual_run_rows": 0}

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None, manual_run_ids=None):
        calls.append(("processor", {"db_path": db_path, "manual_run_ids": manual_run_ids}))
        return {"defect_updates": 0, "run_updates": 0}

    def fake_refresh_materialized_outcomes(source_db_path, hot_db_path, force, defect_ids=None):
        calls.append(("outcomes", {
            "source_db_path": source_db_path,
            "hot_db_path": hot_db_path,
            "force": force,
            "defect_ids": defect_ids,
        }))
        return {"row_count": 0, "skipped": False, "source_signature": "sig-empty"}

    monkeypatch.setattr(ingest_pipeline, "refresh_octane_source", fake_refresh_octane_source)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_manual_runs_only", fake_refresh_octane_manual_runs_only)
    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)
    monkeypatch.setattr(analytics_cli, "refresh_materialized_outcomes", fake_refresh_materialized_outcomes)
    monkeypatch.setattr(analytics_cli, "record_snapshot_refresh", lambda *args, **kwargs: None)
    monkeypatch.setattr(analytics_cli, "activate_snapshot_version", lambda *args, **kwargs: None)

    exit_code = main(["refresh-all-sources"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    expected_years = tuple(range(2025, datetime.now().year + 1))
    expected_text = ",".join(str(year) for year in expected_years)
    assert calls[1][1]["request"].years == expected_years
    assert calls[3][1]["years"] == expected_years
    assert f"years={expected_text}" in stdout
    assert f"manual_years={expected_text}" in stdout


def test_analytics_cli_prepare_duplicate_search_index_invokes_bridge_warmup(
    monkeypatch,
    capsys,
) -> None:
    captured: dict[str, object] = {}

    def fake_prepare_duplicate_search_index() -> dict[str, object]:
        captured["called"] = True
        return {
            "success": True,
            "result": {
                "dataset_size": 42,
                "index_ready": True,
                "timings": {"total_ms": 12.3},
            },
        }

    monkeypatch.setattr(analytics_cli, "_prepare_duplicate_search_index", fake_prepare_duplicate_search_index, raising=False)

    exit_code = main(["prepare-duplicate-search-index"])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["called"] is True
    assert '"dataset_size": 42' in stdout
    assert '"index_ready": true' in stdout


def test_analytics_cli_evaluate_duplicate_search_invokes_eval_runner(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    eval_path = tmp_path / "eval_cases.json"
    eval_path.write_text("[]", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run_duplicate_search_eval(eval_cases_path: Path, top_k: int) -> dict[str, object]:
        captured["eval_cases_path"] = eval_cases_path
        captured["top_k"] = top_k
        return {"case_count": 1, "recall_at_k": 1.0}

    monkeypatch.setattr(analytics_cli, "_run_duplicate_search_eval", fake_run_duplicate_search_eval, raising=False)

    exit_code = main([
        "evaluate-duplicate-search",
        "--eval-cases",
        str(eval_path),
        "--top-k",
        "5",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured == {"eval_cases_path": eval_path, "top_k": 5}
    assert '"recall_at_k": 1.0' in stdout


def test_analytics_cli_export_duplicate_search_eval_cases_writes_feedback_cases(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    feedback_db = tmp_path / "feedback.db"
    output_path = tmp_path / "eval_cases.json"
    captured: dict[str, object] = {}

    def fake_export_duplicate_search_eval_cases(feedback_db_path: Path, output_path_arg: Path) -> dict[str, object]:
        captured["feedback_db_path"] = feedback_db_path
        captured["output_path"] = output_path_arg
        output_path_arg.write_text(
            json.dumps([{"query": "wake", "positive_ticket_ids": ["DP-101"], "negative_ticket_ids": []}]),
            encoding="utf-8",
        )
        return {"case_count": 1, "output_path": str(output_path_arg)}

    monkeypatch.setattr(analytics_cli, "_export_duplicate_search_eval_cases", fake_export_duplicate_search_eval_cases, raising=False)

    exit_code = main([
        "export-duplicate-search-eval-cases",
        "--feedback-db-path",
        str(feedback_db),
        "--output-path",
        str(output_path),
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured == {"feedback_db_path": feedback_db, "output_path": output_path}
    assert '"case_count": 1' in stdout
    assert output_path.exists()


def test_analytics_cli_refresh_all_sources_can_prepare_duplicate_index_after_outcomes(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    database_root = tmp_path / "database"
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(database_root))
    calls: list[str] = []

    def fake_build_default_octane_client() -> str:
        calls.append("build_client")
        return "fake-client"

    def fake_refresh_octane_source(*, request, client) -> dict[str, object]:
        calls.append("source")
        return {
            "defect_rows": 3,
            "history_event_rows": 4,
            "defect_ids": ["D-1", "D-2"],
        }

    def fake_refresh_octane_manual_runs_only(*, source_db_path, team_name, years, client, progress=None):
        calls.append("manual_runs")
        return {"manual_run_rows": 7}

    def fake_run_processor_pipeline(db_path, *, asset_root=None, dry_run=False, report_path=None, manual_run_ids=None):
        calls.append("processor")
        return {"defect_updates": 2, "run_updates": 3}

    def fake_refresh_materialized_outcomes(source_db_path, hot_db_path, force, defect_ids=None):
        calls.append("outcomes")
        return {"row_count": 11, "skipped": False, "source_signature": "sig-2"}

    def fake_prepare_duplicate_search_index() -> dict[str, object]:
        calls.append("duplicate_index")
        return {"success": True, "result": {"dataset_size": 3, "index_ready": True}}

    monkeypatch.setattr(ingest_pipeline, "refresh_octane_source", fake_refresh_octane_source)
    monkeypatch.setattr(ingest_client, "build_default_octane_client", fake_build_default_octane_client)
    monkeypatch.setattr(ingest_pipeline, "refresh_octane_manual_runs_only", fake_refresh_octane_manual_runs_only)
    monkeypatch.setattr(analytics_cli, "run_processor_pipeline", fake_run_processor_pipeline)
    monkeypatch.setattr(analytics_cli, "refresh_materialized_outcomes", fake_refresh_materialized_outcomes)
    monkeypatch.setattr(analytics_cli, "build_full_picture_snapshot_version", lambda source_db_path: "snapshot-test")
    monkeypatch.setattr(analytics_cli, "format_snapshot_source_mtime", lambda source_db_path: "mtime-test")
    monkeypatch.setattr(analytics_cli, "record_snapshot_refresh", lambda *args, **kwargs: None)
    monkeypatch.setattr(analytics_cli, "activate_snapshot_version", lambda *args, **kwargs: None)
    monkeypatch.setattr(analytics_cli, "_prepare_duplicate_search_index", fake_prepare_duplicate_search_index, raising=False)

    exit_code = main([
        "refresh-all-sources",
        "--teams",
        "DTSV_China",
        "--years",
        "2026",
        "--team-name",
        "DTSV_China",
        "--manual-years",
        "2026",
        "--prepare-duplicate-index",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert calls == [
        "build_client",
        "source",
        "build_client",
        "manual_runs",
        "processor",
        "outcomes",
        "duplicate_index",
    ]
    assert "Step 4/4: preparing duplicate-search index..." in stdout
    assert '"duplicate_search_index"' in stdout


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


def test_analytics_cli_refresh_full_picture_outcomes_activates_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_db = tmp_path / "history.db"
    hot_db = tmp_path / "database" / "hot" / "vizion_serving.db"

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT,
                field_name TEXT,
                event_timestamp TEXT,
                old_value TEXT,
                new_value TEXT,
                old_value_text TEXT,
                new_value_text TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, field_name, event_timestamp, old_value, new_value, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-001",
                "status_phase",
                "2026-06-01T00:00:00Z",
                "08",
                "06",
                "08-Resolved Forward",
                "06-Ready for Test",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("VIZION_FULL_PICTURE_HISTORY_DB_PATH", str(source_db))
    monkeypatch.setenv("VIZION_FULL_PICTURE_HOT_DB_PATH", str(hot_db))

    exit_code = main(["refresh-full-picture-outcomes"])

    state = read_active_snapshot_state(hot_db)

    assert exit_code == 0
    assert state["refresh_status"] == "ready"
    assert state["active_snapshot_version"]
    assert state["source_db_path"] == str(source_db.resolve())
