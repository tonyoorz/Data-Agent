from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date
from pathlib import Path
import sys

import backend.analytics_cli as analytics_cli
from backend.analytics_cli import main
import backend.analytics.legacy_bridge as legacy_bridge
from backend.analytics.legacy_bridge import sync_octane_auth_from_legacy
from backend.analytics.ingest.source_store import OctaneSourceStore
from backend.analytics.legacy_octane_db import OctaneSQLiteStore
from backend.analytics.schema import ensure_schema


def test_analytics_cli_refresh_legacy_qgate_source_defaults_to_incremental_history(monkeypatch, capsys, tmp_path) -> None:
    captured: dict[str, object] = {}

    def fake_refresh_legacy_qgate_source_incremental(*, teams, years, include_comments, history_max_workers, save_files, cookie_file):
        captured["call"] = {
            "teams": teams,
            "years": years,
            "include_comments": include_comments,
            "history_max_workers": history_max_workers,
            "save_files": save_files,
            "cookie_file": cookie_file,
        }
        return {"bridge": "qgate-incremental", "defect_rows": 1, "history_event_rows": 2}

    monkeypatch.setattr(analytics_cli, "refresh_legacy_qgate_source_incremental", fake_refresh_legacy_qgate_source_incremental)

    exit_code = main([
        "refresh-legacy-qgate-source",
        "--teams",
        "DTSV_China,[AT]CoC_EI_IuK",
        "--years",
        "2025,2026",
        "--skip-comments",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {
        "teams": ("DTSV_China", "[AT]CoC_EI_IuK"),
        "years": (2025, 2026),
        "include_comments": False,
        "history_max_workers": 50,
        "save_files": False,
        "cookie_file": None,
    }
    assert '"bridge": "qgate-incremental"' in stdout


def test_analytics_cli_refresh_legacy_qgate_source_full_history_invokes_bridge(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    def fake_run_legacy_qgate_source(*, teams, years, include_history, include_comments, save_files, cookie_file):
        captured["call"] = {
            "teams": teams,
            "years": years,
            "include_history": include_history,
            "include_comments": include_comments,
            "save_files": save_files,
            "cookie_file": cookie_file,
        }
        return {"bridge": "qgate", "defect_rows": 1, "history_event_rows": 2}

    monkeypatch.setattr(analytics_cli, "run_legacy_qgate_source", fake_run_legacy_qgate_source)

    exit_code = main([
        "refresh-legacy-qgate-source",
        "--teams",
        "DTSV_China,[AT]CoC_EI_IuK",
        "--years",
        "2025,2026",
        "--skip-comments",
        "--full-history",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {
        "teams": ("DTSV_China", "[AT]CoC_EI_IuK"),
        "years": (2025, 2026),
        "include_history": True,
        "include_comments": False,
        "save_files": False,
        "cookie_file": None,
    }
    assert '"bridge": "qgate"' in stdout


def test_analytics_cli_refresh_legacy_testcase_source_invokes_bridge(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    def fake_run_legacy_testcase_source(
        *,
        team_name,
        release_name,
        page_limit,
        workers,
        workitems_fallback_max,
        workitems_fallback_workers,
        save_files,
        cookie_file,
    ):
        captured["call"] = {
            "team_name": team_name,
            "release_name": release_name,
            "page_limit": page_limit,
            "workers": workers,
            "workitems_fallback_max": workitems_fallback_max,
            "workitems_fallback_workers": workitems_fallback_workers,
            "save_files": save_files,
            "cookie_file": cookie_file,
        }
        return {"bridge": "testcase", "testcase_rows": 3, "testcase_relation_rows": 4}

    monkeypatch.setattr(analytics_cli, "run_legacy_testcase_source", fake_run_legacy_testcase_source)

    exit_code = main([
        "refresh-legacy-testcase-source",
        "--team-name",
        "DTSV_China",
        "--release-name",
        "R-26-01",
        "--page-limit",
        "250",
        "--workers",
        "6",
        "--workitems-fallback-max",
        "120",
        "--workitems-fallback-workers",
        "3",
        "--save-files",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {
        "team_name": "DTSV_China",
        "release_name": "R-26-01",
        "page_limit": 250,
        "workers": 6,
        "workitems_fallback_max": 120,
        "workitems_fallback_workers": 3,
        "save_files": True,
        "cookie_file": None,
    }
    assert '"bridge": "testcase"' in stdout


def test_analytics_cli_resume_legacy_qgate_history_source_invokes_bridge(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    def fake_resume_legacy_qgate_history_source(*, teams, years, history_max_workers, refreshed_after, save_files, cookie_file):
        captured["call"] = {
            "teams": teams,
            "years": years,
            "history_max_workers": history_max_workers,
            "refreshed_after": refreshed_after,
            "save_files": save_files,
            "cookie_file": cookie_file,
        }
        return {"bridge": "qgate-history-resume", "team_summaries": []}

    monkeypatch.setattr(analytics_cli, "resume_legacy_qgate_history_source", fake_resume_legacy_qgate_history_source)

    exit_code = main([
        "resume-legacy-qgate-history-source",
        "--teams",
        "[AT]CoC_EI_IuK",
        "--years",
        "2025,2026",
        "--history-max-workers",
        "12",
        "--refreshed-after",
        "2026-06-01T06:30:00Z",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {
        "teams": ("[AT]CoC_EI_IuK",),
        "years": (2025, 2026),
        "history_max_workers": 12,
        "refreshed_after": "2026-06-01T06:30:00Z",
        "save_files": False,
        "cookie_file": None,
    }
    assert '"bridge": "qgate-history-resume"' in stdout


def test_run_legacy_testcase_source_passes_throttle_arguments_to_legacy_downloader(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    source_db.touch()
    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("COOKIE=1", encoding="utf-8")

    @contextmanager
    def fake_legacy_environment(_legacy_root: Path):
        yield

    class FakeModule:
        def main(self):
            captured["argv"] = sys.argv[:]

    monkeypatch.setattr(legacy_bridge, "resolve_legacy_repo_root", lambda: legacy_root)
    monkeypatch.setattr(legacy_bridge, "get_full_picture_source_db_path", lambda: source_db)
    monkeypatch.setattr(legacy_bridge, "_legacy_environment", fake_legacy_environment)
    monkeypatch.setattr(legacy_bridge.importlib, "import_module", lambda name: FakeModule())

    summary = legacy_bridge.run_legacy_testcase_source(
        team_name="DTSV_China",
        release_name="ALL",
        page_limit=250,
        workers=6,
        workitems_fallback_max=120,
        workitems_fallback_workers=3,
        save_files=True,
        cookie_file=str(cookie_file),
    )

    assert summary["bridge"] == "testcase"
    assert captured["argv"] == [
        "testcase_downloader.py",
        "--auth-method",
        "cookie",
        "--cookie-file",
        str(cookie_file),
        "--dtsv-all",
        "--team-name",
        "DTSV_China",
        "--save-db",
        "--db-path",
        str(source_db),
        "--release-name",
        "ALL",
        "--page-limit",
        "250",
        "--workers",
        "6",
        "--workitems-fallback-max",
        "120",
        "--workitems-fallback-workers",
        "3",
    ]


def test_resume_legacy_qgate_history_source_only_queues_stale_defects(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {"calls": []}
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    ensure_schema(source_db)

    source_store = OctaneSourceStore(source_db)
    source_store.create_tables()
    source_store.close()

    seed_store = OctaneSQLiteStore(str(source_db))
    try:
        seed_store.create_tables()
        seed_store.upsert_defects_batch(
            [
                {
                    "id": "AT-OLD",
                    "name": "AT old history",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "year": 2025,
                },
                {
                    "id": "AT-FRESH",
                    "name": "AT fresh history",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "year": 2025,
                },
                {
                    "id": "AT-MISSING",
                    "name": "AT missing history",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "year": 2026,
                },
                {
                    "id": "DTSV-DONE",
                    "name": "DTSV done history",
                    "problem_finder_team_udf": {"name": "DTSV_China"},
                    "year": 2025,
                },
            ],
            year=2025,
        )
    finally:
        seed_store.close()

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "AT-OLD", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-05-20T00:00:00Z",
                "updated", "tester", "[AT]CoC_EI_IuK", 0, 0, "01", "02",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "AT-FRESH", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-06-01T06:45:00Z",
                "updated", "tester", "[AT]CoC_EI_IuK", 0, 0, "01", "02",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "DTSV-DONE", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-06-01T06:45:00Z",
                "updated", "tester", "DTSV_China", 0, 0, "01", "02",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("COOKIE=1", encoding="utf-8")

    @contextmanager
    def fake_legacy_environment(_legacy_root: Path):
        yield

    class FakeSession:
        def close(self) -> None:
            return None

    class FakeStore:
        def close(self) -> None:
            captured["store_closed"] = True

    class FakeD6:
        @staticmethod
        def get_authenticated_session(_auth_method: str, cookie_file_path: str | None = None):
            captured["cookie_file_path"] = cookie_file_path
            return FakeSession()

    class FakeModule:
        d6 = FakeD6()

        @staticmethod
        def initialize_qgate_store(db_path: str, defer_history_events: bool = True):
            captured["init"] = {"db_path": db_path, "defer_history_events": defer_history_events}
            return FakeStore()

        @staticmethod
        def save_qgate_histories(*, defect_ids, session, max_workers, history_dir, team, store, save_files, save_csv):
            captured["calls"].append(
                {
                    "defect_ids": list(defect_ids),
                    "max_workers": max_workers,
                    "team": team,
                    "save_files": save_files,
                    "save_csv": save_csv,
                }
            )
            return list(defect_ids), []

    monkeypatch.setattr(legacy_bridge, "resolve_legacy_repo_root", lambda: legacy_root)
    monkeypatch.setattr(legacy_bridge, "get_full_picture_source_db_path", lambda: source_db)
    monkeypatch.setattr(legacy_bridge, "_legacy_environment", fake_legacy_environment)
    monkeypatch.setattr(legacy_bridge.importlib, "import_module", lambda name: FakeModule())

    summary = legacy_bridge.resume_legacy_qgate_history_source(
        teams=("[AT]CoC_EI_IuK",),
        years=(2025, 2026),
        history_max_workers=7,
        refreshed_after="2026-06-01T06:30:00Z",
        save_files=False,
        cookie_file=str(cookie_file),
    )

    assert summary["bridge"] == "qgate-history-resume"
    assert summary["team_summaries"] == [
        {
            "team": "[AT]CoC_EI_IuK",
            "queued_defects": 2,
            "processed_defects": 2,
            "failed_defects": 0,
        }
    ]
    assert captured["calls"] == [
        {
            "defect_ids": ["AT-MISSING", "AT-OLD"],
            "max_workers": 7,
            "team": "[AT]CoC_EI_IuK",
            "save_files": False,
            "save_csv": False,
        }
    ]


def test_load_incremental_history_ids_by_team_selects_changed_or_missing_histories(tmp_path: Path) -> None:
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    ensure_schema(source_db)

    store = OctaneSQLiteStore(str(source_db))
    try:
        store.create_tables()
        store.upsert_defects_batch(
            [
                {
                    "id": "AT-UNCHANGED",
                    "name": "AT unchanged",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "last_modified": "2026-05-20T00:00:00Z",
                },
                {
                    "id": "AT-CHANGED",
                    "name": "AT changed",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "last_modified": "2026-06-01T08:00:00Z",
                },
                {
                    "id": "AT-MISSING",
                    "name": "AT missing",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "last_modified": "2026-06-01T08:10:00Z",
                },
                {
                    "id": "DTSV-DONE",
                    "name": "DTSV done",
                    "problem_finder_team_udf": {"name": "DTSV_China"},
                    "last_modified": "2026-06-01T08:05:00Z",
                },
            ],
            year=2025,
        )
    finally:
        store.close()

    conn = sqlite3.connect(source_db)
    try:
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "AT-UNCHANGED", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-06-01T08:05:00Z",
                "updated", "tester", "[AT]CoC_EI_IuK", 0, 0, "01", "02",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "AT-CHANGED", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-06-01T07:00:00Z",
                "updated", "tester", "[AT]CoC_EI_IuK", 0, 0, "01", "02",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, action, user_name, team, entry_index, change_index, old_value_text, new_value_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "DTSV-DONE", "2026-01-01T00:00:00Z", "phase", "01", "02", "2026-06-01T08:10:00Z",
                "updated", "tester", "DTSV_China", 0, 0, "01", "02",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    history_ids = legacy_bridge._load_incremental_history_ids_by_team(
        source_db_path=source_db,
        teams=("[AT]CoC_EI_IuK",),
        years=(2025,),
    )

    assert history_ids == {"[AT]CoC_EI_IuK": ["AT-CHANGED", "AT-MISSING"]}


def test_load_incremental_defect_windows_by_team_year_uses_last_modified_overlap(tmp_path: Path) -> None:
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    ensure_schema(source_db)

    store = OctaneSQLiteStore(str(source_db))
    try:
        store.create_tables()
        store.upsert_defects_batch(
            [
                {
                    "id": "AT-2025",
                    "name": "AT 2025",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "year": 2025,
                    "last_modified": "2026-05-20T10:00:00Z",
                },
                {
                    "id": "AT-2026",
                    "name": "AT 2026",
                    "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
                    "year": 2026,
                    "last_modified": "2026-06-01T08:00:00Z",
                },
            ],
            year=2025,
        )
    finally:
        store.close()

    windows = legacy_bridge._load_incremental_defect_windows_by_team_year(
        source_db_path=source_db,
        teams=("[AT]CoC_EI_IuK", "DTSV_China"),
        years=(2025, 2026),
        overlap_days=3,
        today=date(2026, 6, 1),
    )

    assert windows == {
        ("[AT]CoC_EI_IuK", 2025): {
            "start_date": "2026-05-17",
            "end_date": "2026-06-01",
            "mode": "incremental",
        },
        ("[AT]CoC_EI_IuK", 2026): {
            "start_date": "2026-05-29",
            "end_date": "2026-06-01",
            "mode": "incremental",
        },
        ("DTSV_China", 2025): {
            "start_date": "2025-01-01",
            "end_date": "2026-06-01",
            "mode": "full",
        },
        ("DTSV_China", 2026): {
            "start_date": "2026-01-01",
            "end_date": "2026-06-01",
            "mode": "full",
        },
    }


def test_run_legacy_qgate_defect_source_incremental_groups_payloads_by_year(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {"queries": [], "saved": []}
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    source_db.touch()
    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("COOKIE=1", encoding="utf-8")

    @contextmanager
    def fake_legacy_environment(_legacy_root: Path):
        yield

    class FakeSession:
        def close(self) -> None:
            return None

    class FakeStore:
        def close(self) -> None:
            captured["store_closed"] = True

    class FakeD6:
        EP_DEFECT = "defects"
        DEFAULT_F_DEFECT_MAIN = ("id", "name", "creation_time", "last_modified")

        @staticmethod
        def get_authenticated_session(_auth_method: str, cookie_file_path: str | None = None):
            captured["cookie_file_path"] = cookie_file_path
            return FakeSession()

        @staticmethod
        def fetch_octane_data_parallel(session, endpoint, fields, query, order_by, limit_per_page, max_workers):
            captured["queries"].append(query)
            if "creation_time>='2025-01-01T00:00:00Z'" in query:
                return [
                    {
                        "id": "AT-2025-1",
                        "name": "Old ticket changed",
                        "year": 2025,
                        "creation_time": "2025-03-01T00:00:00Z",
                        "last_modified": "2026-05-30T09:00:00Z",
                    }
                ]
            if "creation_time>='2026-01-01T00:00:00Z'" in query:
                return [
                    {
                        "id": "AT-2026-1",
                        "name": "New ticket",
                        "year": 2026,
                        "creation_time": "2026-05-31T00:00:00Z",
                        "last_modified": "2026-05-31T09:00:00Z",
                    }
                ]
            return []

        @staticmethod
        def fetch_comments_for_defects(session, defect_ids, batch_size, max_workers):
            return [{"owner_work_item": {"id": defect_ids[0]}, "id": f"C-{defect_ids[0]}", "text": "comment"}]

        @staticmethod
        def _html_to_text(value: str) -> str:
            return value

    class FakeModule:
        d6 = FakeD6()

        @staticmethod
        def fetch_team_name_to_id(_session):
            return {"[AT]CoC_EI_IuK": "TEAM-1"}

        @staticmethod
        def slugify_team_name(value: str) -> str:
            return value.replace(" ", "_")

        @staticmethod
        def initialize_qgate_store(db_path: str, defer_history_events: bool = True):
            captured["init"] = {"db_path": db_path, "defer_history_events": defer_history_events}
            return FakeStore()

        @staticmethod
        def save_defect_batch(defect_data_list, **kwargs):
            captured["saved"].append({"ids": [row["id"] for row in defect_data_list], **kwargs})
            return {str(row["id"]) for row in defect_data_list}

    monkeypatch.setattr(legacy_bridge, "resolve_legacy_repo_root", lambda: legacy_root)
    monkeypatch.setattr(legacy_bridge, "get_full_picture_source_db_path", lambda: source_db)
    monkeypatch.setattr(legacy_bridge, "_legacy_environment", fake_legacy_environment)
    monkeypatch.setattr(legacy_bridge, "_load_incremental_defect_windows_by_team_year", lambda **kwargs: {
        ("[AT]CoC_EI_IuK", 2025): {"start_date": "2026-05-17", "end_date": "2026-06-01", "mode": "incremental"},
        ("[AT]CoC_EI_IuK", 2026): {"start_date": "2026-05-29", "end_date": "2026-06-01", "mode": "incremental"},
    })
    monkeypatch.setattr(legacy_bridge.importlib, "import_module", lambda name: FakeModule())

    summary = legacy_bridge.run_legacy_qgate_defect_source_incremental(
        teams=("[AT]CoC_EI_IuK",),
        years=(2025, 2026),
        include_comments=True,
        save_files=False,
        cookie_file=str(cookie_file),
    )

    assert summary["bridge"] == "qgate-defect-incremental"
    assert captured["queries"] == [
        '"(problem_finder_team_udf={id=\'TEAM-1\'};creation_time>=\'2025-01-01T00:00:00Z\';creation_time<=\'2025-12-31T23:59:59Z\';last_modified>=\'2026-05-17T00:00:00Z\';last_modified<=\'2026-06-01T23:59:59Z\')"',
        '"(problem_finder_team_udf={id=\'TEAM-1\'};creation_time>=\'2026-01-01T00:00:00Z\';creation_time<=\'2026-12-31T23:59:59Z\';last_modified>=\'2026-05-29T00:00:00Z\';last_modified<=\'2026-06-01T23:59:59Z\')"',
    ]
    assert captured["saved"] == [
        {
            "ids": ["AT-2025-1"],
            "team": "[AT]CoC_EI_IuK",
            "year_str": "2025",
            "team_slug": "[AT]CoC_EI_IuK",
            "defect_dir": str(legacy_root / "qgate" / "defect"),
            "save_csv": False,
            "save_excel": False,
            "save_files": False,
            "store": captured["saved"][0]["store"],
            "fetched_at": summary["fetched_at"],
        },
        {
            "ids": ["AT-2026-1"],
            "team": "[AT]CoC_EI_IuK",
            "year_str": "2026",
            "team_slug": "[AT]CoC_EI_IuK",
            "defect_dir": str(legacy_root / "qgate" / "defect"),
            "save_csv": False,
            "save_excel": False,
            "save_files": False,
            "store": captured["saved"][1]["store"],
            "fetched_at": summary["fetched_at"],
        },
    ]


def test_run_legacy_qgate_defect_source_incremental_reuses_comments_for_unchanged_defects(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {
        "comment_fetch_calls": 0,
        "saved_comments": [],
    }
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    source_db = tmp_path / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)

    store = OctaneSourceStore(source_db)
    store.create_tables()
    store.upsert_defects(
        [
            {
                "id": "AT-2026-1",
                "name": "Existing defect",
                "year": 2026,
                "creation_time": "2026-05-31T00:00:00Z",
                "last_modified": "2026-05-31T09:00:00Z",
                "comments": [{"id": "C-OLD", "text": "old"}],
                "problem_finder_team_udf": {"name": "[AT]CoC_EI_IuK"},
            }
        ],
        team="[AT]CoC_EI_IuK",
        year=2026,
    )
    store.close()

    conn = sqlite3.connect(str(source_db))
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS octane_defect_comment_refresh_state (
                defect_id TEXT PRIMARY KEY,
                last_defect_modified TEXT NOT NULL,
                last_synced_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO octane_defect_comment_refresh_state(defect_id, last_defect_modified, last_synced_at)
            VALUES (?, ?, ?)
            """,
            ("AT-2026-1", "2026-05-31T09:00:00Z", "2026-06-08T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("COOKIE=1", encoding="utf-8")

    @contextmanager
    def fake_legacy_environment(_legacy_root: Path):
        yield

    class FakeSession:
        def close(self) -> None:
            return None

    class FakeStore:
        def close(self) -> None:
            return None

    class FakeD6:
        EP_DEFECT = "defects"
        DEFAULT_F_DEFECT_MAIN = ("id", "name", "creation_time", "last_modified")

        @staticmethod
        def get_authenticated_session(_auth_method: str, cookie_file_path: str | None = None):
            captured["cookie_file_path"] = cookie_file_path
            return FakeSession()

        @staticmethod
        def fetch_octane_data_parallel(session, endpoint, fields, query, order_by, limit_per_page, max_workers):
            return [
                {
                    "id": "AT-2026-1",
                    "name": "Existing defect",
                    "year": 2026,
                    "creation_time": "2026-05-31T00:00:00Z",
                    "last_modified": "2026-05-31T09:00:00Z",
                }
            ]

        @staticmethod
        def fetch_comments_for_defects(session, defect_ids, batch_size, max_workers):
            captured["comment_fetch_calls"] = int(captured["comment_fetch_calls"]) + 1
            return [{"owner_work_item": {"id": defect_ids[0]}, "id": f"C-{defect_ids[0]}", "text": "new"}]

        @staticmethod
        def _html_to_text(value: str) -> str:
            return value

    class FakeModule:
        d6 = FakeD6()

        @staticmethod
        def fetch_team_name_to_id(_session):
            return {"[AT]CoC_EI_IuK": "TEAM-1"}

        @staticmethod
        def slugify_team_name(value: str) -> str:
            return value.replace(" ", "_")

        @staticmethod
        def initialize_qgate_store(db_path: str, defer_history_events: bool = True):
            return FakeStore()

        @staticmethod
        def save_defect_batch(defect_data_list, **kwargs):
            captured["saved_comments"].append(defect_data_list[0].get("comments"))
            return {str(row["id"]) for row in defect_data_list}

    monkeypatch.setattr(legacy_bridge, "resolve_legacy_repo_root", lambda: legacy_root)
    monkeypatch.setattr(legacy_bridge, "get_full_picture_source_db_path", lambda: source_db)
    monkeypatch.setattr(legacy_bridge, "_legacy_environment", fake_legacy_environment)
    monkeypatch.setattr(legacy_bridge, "_load_incremental_defect_windows_by_team_year", lambda **kwargs: {
        ("[AT]CoC_EI_IuK", 2026): {"start_date": "2026-05-29", "end_date": "2026-06-01", "mode": "incremental"},
    })
    monkeypatch.setattr(legacy_bridge.importlib, "import_module", lambda name: FakeModule())

    summary = legacy_bridge.run_legacy_qgate_defect_source_incremental(
        teams=("[AT]CoC_EI_IuK",),
        years=(2026,),
        include_comments=True,
        save_files=False,
        cookie_file=str(cookie_file),
    )

    assert summary["bridge"] == "qgate-defect-incremental"
    assert captured["comment_fetch_calls"] == 0
    assert captured["saved_comments"][0] == [{"id": "C-OLD", "text": "old"}]


def test_refresh_legacy_qgate_source_incremental_uses_incremental_defect_refresh(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_run_legacy_qgate_defect_source_incremental(*, teams, years, include_comments, save_files, cookie_file, overlap_days=3):
        captured["defects"] = {
            "teams": teams,
            "years": years,
            "include_comments": include_comments,
            "save_files": save_files,
            "cookie_file": cookie_file,
            "overlap_days": overlap_days,
        }
        return {
            "bridge": "qgate-defect-incremental",
            "source_db_path": "source.db",
            "cookie_file": cookie_file,
            "team_summaries": [{"team": "DTSV_China", "refreshed_defects": 2}],
            "refreshed_defect_ids_by_team": {"DTSV_China": ["D-1", "D-2"]},
        }

    def fake_resume_incremental_legacy_qgate_history_source(*, teams, years, history_max_workers, save_files, cookie_file, defect_ids_by_team=None):
        captured["history"] = {
            "teams": teams,
            "years": years,
            "history_max_workers": history_max_workers,
            "save_files": save_files,
            "cookie_file": cookie_file,
            "defect_ids_by_team": defect_ids_by_team,
        }
        return {
            "bridge": "qgate-history-incremental",
            "cookie_file": cookie_file,
            "team_summaries": [{"team": "DTSV_China", "processed_defects": 2}],
        }

    monkeypatch.setattr(legacy_bridge, "run_legacy_qgate_defect_source_incremental", fake_run_legacy_qgate_defect_source_incremental)
    monkeypatch.setattr(legacy_bridge, "resume_incremental_legacy_qgate_history_source", fake_resume_incremental_legacy_qgate_history_source)

    summary = legacy_bridge.refresh_legacy_qgate_source_incremental(
        teams=("DTSV_China",),
        years=(2025, 2026),
        include_comments=False,
        history_max_workers=8,
        save_files=False,
        cookie_file=None,
    )

    assert captured == {
        "defects": {
            "teams": ("DTSV_China",),
            "years": (2025, 2026),
            "include_comments": False,
            "save_files": False,
            "cookie_file": None,
            "overlap_days": 3,
        },
        "history": {
            "teams": ("DTSV_China",),
            "years": (2025, 2026),
            "history_max_workers": 8,
            "save_files": False,
            "cookie_file": None,
            "defect_ids_by_team": {"DTSV_China": ["D-1", "D-2"]},
        },
    }
    assert summary["bridge"] == "qgate-incremental"
    assert summary["defect_refresh"]["bridge"] == "qgate-defect-incremental"


def test_sync_octane_auth_from_legacy_copies_cookie_into_current_repo(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / "vizion-lab"
    workspace_root.mkdir(parents=True)
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    (legacy_root / "cookie.txt").write_text("LEGACY_COOKIE=1", encoding="utf-8")
    (legacy_root / "login_info.txt").write_text(json.dumps({"username": "q1", "password": "pw"}), encoding="utf-8")
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(workspace_root))

    summary = sync_octane_auth_from_legacy(sync_login=True)

    assert summary["cookie_synced"] is True
    assert summary["login_synced"] is True
    assert (workspace_root / "cookie.txt").read_text(encoding="utf-8") == "LEGACY_COOKIE=1"
    assert json.loads((workspace_root / "login_info.txt").read_text(encoding="utf-8")) == {"username": "q1", "password": "pw"}


def test_refresh_octane_cookie_via_legacy_passes_headless_flag(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    (legacy_root / "playwright_cookie_manager.py").write_text("", encoding="utf-8")

    def fake_subprocess_run(argv, cwd, check):
        captured["argv"] = list(argv)
        captured["cwd"] = cwd
        captured["check"] = check

        class Result:
            returncode = 0

        return Result()

    monkeypatch.setattr(legacy_bridge, "resolve_legacy_repo_root", lambda: legacy_root)
    monkeypatch.setattr(legacy_bridge.subprocess, "run", fake_subprocess_run)
    monkeypatch.setattr(
        legacy_bridge,
        "sync_octane_auth_from_legacy",
        lambda *, sync_login: {"cookie_synced": True, "login_synced": sync_login},
    )

    summary = legacy_bridge.refresh_octane_cookie(
        prefer_legacy=True,
        sync_login=False,
        headless=True,
    )

    assert summary["mode"] == "legacy-playwright"
    assert summary["headless_requested"] is True
    assert captured["argv"] == [
        sys.executable,
        str(legacy_root / "playwright_cookie_manager.py"),
        "--refresh",
        "--headless",
    ]
    assert captured["cwd"] == legacy_root
    assert captured["check"] is False


def test_analytics_cli_refresh_octane_cookie_invokes_cookie_refresh(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    def fake_refresh_octane_cookie(*, prefer_legacy: bool, sync_login: bool, headless: bool) -> dict[str, object]:
        captured["call"] = {
            "prefer_legacy": prefer_legacy,
            "sync_login": sync_login,
            "headless": headless,
        }
        return {"cookie_refreshed": True, "mode": "legacy-playwright"}

    monkeypatch.setattr(analytics_cli, "refresh_octane_cookie", fake_refresh_octane_cookie)

    exit_code = main([
        "refresh-octane-cookie",
        "--headless",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {
        "prefer_legacy": True,
        "sync_login": False,
        "headless": True,
    }
    assert '"cookie_refreshed": true' in stdout


def test_analytics_cli_sync_octane_cookie_invokes_sync(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    def fake_sync_octane_auth_from_legacy(*, sync_login: bool) -> dict[str, object]:
        captured["call"] = {"sync_login": sync_login}
        return {"cookie_synced": True, "login_synced": True}

    monkeypatch.setattr(analytics_cli, "sync_octane_auth_from_legacy", fake_sync_octane_auth_from_legacy)

    exit_code = main([
        "sync-octane-cookie",
        "--sync-login",
    ])

    stdout = capsys.readouterr().out
    assert exit_code == 0
    assert captured["call"] == {"sync_login": True}
    assert '"login_synced": true' in stdout