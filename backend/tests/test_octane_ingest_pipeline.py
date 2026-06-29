from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from backend.analytics.ingest.client import OctaneApiClient
from backend.analytics.ingest.pipeline import IngestRequest, refresh_octane_manual_runs_only, refresh_octane_source


class FakeOctaneClient:
    def __init__(self) -> None:
        self.defect_calls: list[dict[str, object]] = []
        self.manual_run_calls: list[dict[str, object]] = []
        self.comment_calls: list[list[str]] = []
        self.history_calls: list[list[str]] = []

    def list_teams(self) -> list[dict[str, str]]:
        return [
            {"id": "1", "name": "DTSV_China"},
            {"id": "2", "name": "[AT]CoC_EI_IuK"},
        ]

    def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
        self.defect_calls.append({"team_id": team_id, "year": year, "modified_since": modified_since})
        return [
            {
                "id": f"D-{team_id}-{year}",
                "name": "Wake defect",
                "last_modified": f"{year}-01-02T00:00:00Z",
                "phase": {"name": "06"},
            }
        ]

    def fetch_comments_for_defects(self, defect_ids: list[str]) -> list[dict[str, object]]:
        self.comment_calls.append(list(defect_ids))
        return [{"defect_id": defect_ids[0], "text": "comment one"}]

    def fetch_history(self, *, defect_id: str) -> dict[str, object]:
        self.history_calls.append([defect_id])
        return {
            "data": [
                {
                    "timestamp": "2026-01-02T00:00:00Z",
                    "change_set": [
                        {
                            "field_name": "phase",
                            "old_value": "08",
                            "value": "06",
                        }
                    ],
                }
            ]
        }

    def fetch_histories_for_defects(
        self,
        defect_ids: list[str],
        *,
        max_workers: int = 1,
        modified_since_by_defect: dict[str, str | None] | None = None,
    ) -> dict[str, dict[str, object]]:
        self.history_calls.append(list(defect_ids))
        return {defect_id: self.fetch_history(defect_id=defect_id) for defect_id in defect_ids}

    def fetch_manual_runs(
        self,
        *,
        team_id: str,
        year: int,
        modified_since: str | None = None,
        include_related_work_items: bool = True,
        progress=None,
    ) -> list[dict[str, object]]:
        self.manual_run_calls.append(
            {
                "team_id": team_id,
                "year": year,
                "modified_since": modified_since,
                "include_related_work_items": include_related_work_items,
            }
        )
        if progress is not None:
            progress(f"manual-runs page year={year}")
        row = {
            "id": f"MR-{team_id}-{year}",
            "defect": {"id": f"D-{team_id}-{year}"},
            "test": {"id": f"T-{team_id}-{year}"},
            "test_name": "Wake test",
            "status": "Passed",
            "release": {"name": f"R-{str(year)[-2:]}-01"},
        }
        if include_related_work_items:
            row["related_work_items"] = [
                {
                    "id": f"F-{team_id}-{year}",
                    "name": "Wake feature",
                    "subtype": "feature",
                    "path": "epic/wake-feature",
                },
                {
                    "id": f"S-{team_id}-{year}",
                    "name": "Wake story",
                    "subtype": "story",
                    "path": "epic/wake-feature/wake-story",
                },
            ]
        return [
            {
                **row,
            }
        ]


def test_refresh_octane_source_writes_all_core_entities(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    summary = refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("all",),
            years=(2026,),
            include_history=True,
            include_comments=True,
            include_testing=True,
        ),
        client=FakeOctaneClient(),
    )

    assert summary == {
        "defect_rows": 2,
        "defect_ids": ["D-1-2026", "D-2-2026"],
        "comment_refreshed_defects": 2,
        "comment_reused_defects": 0,
        "history_queued_defects": 2,
        "history_skipped_defects": 0,
        "history_event_rows": 2,
        "manual_run_rows": 2,
        "testcase_rows": 2,
        "testcase_relation_rows": 6,
    }

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM octane_defects").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_defect_history_events").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_testcase_relations").fetchone()[0] == 6

        testcase_row = conn.execute(
            "SELECT scope_team, scope_release, defect_ids_json, feature_ids_json, story_ids_json FROM octane_testcases WHERE test_id = ?",
            ("T-1-2026",),
        ).fetchone()
        assert testcase_row[0] == "DTSV_China"
        assert testcase_row[1] == "R-26-01"
        assert json.loads(testcase_row[2]) == ["D-1-2026"]
        assert json.loads(testcase_row[3]) == ["F-1-2026"]
        assert json.loads(testcase_row[4]) == ["S-1-2026"]

        relation_types = conn.execute(
            "SELECT relation_type, related_id FROM octane_testcase_relations WHERE test_id = ? ORDER BY relation_type, related_id",
            ("T-1-2026",),
        ).fetchall()
        assert relation_types == [
            ("defect", "D-1-2026"),
            ("feature", "F-1-2026"),
            ("story", "S-1-2026"),
        ]
    finally:
        conn.close()


def test_refresh_octane_source_passes_defect_modified_since_watermark(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                problem_finder_team TEXT,
                year TEXT,
                last_modified TEXT
            );
            INSERT INTO octane_defects(
                defect_id, name, raw_json, fetched_at, problem_finder_team, year, last_modified
            ) VALUES (
                'D-EXISTING', 'Existing', '{}', '2026-06-12T00:00:00Z', 'DTSV_China', '2026', '2026-06-12T12:00:00Z'
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    client = FakeOctaneClient()
    refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("DTSV_China",),
            years=(2026,),
            include_history=False,
            include_comments=False,
            include_testing=False,
        ),
        client=client,
    )

    assert client.defect_calls == [
        {"team_id": "1", "year": 2026, "modified_since": "2026-06-09T12:00:00Z"}
    ]


def test_refresh_octane_source_fetches_teams_with_limited_parallelism(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    class ConcurrentDefectClient(FakeOctaneClient):
        def __init__(self) -> None:
            super().__init__()
            self._lock = threading.Lock()
            self._active_fetches = 0
            self.max_active_fetches = 0

        def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
            with self._lock:
                self._active_fetches += 1
                self.max_active_fetches = max(self.max_active_fetches, self._active_fetches)
            try:
                time.sleep(0.05)
                return super().fetch_defects(team_id=team_id, year=year, modified_since=modified_since)
            finally:
                with self._lock:
                    self._active_fetches -= 1

    client = ConcurrentDefectClient()
    summary = refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("all",),
            years=(2026,),
            include_history=False,
            include_comments=False,
            include_testing=False,
            team_max_workers=2,
        ),
        client=client,
    )

    assert client.max_active_fetches == 2
    assert summary["defect_rows"] == 2


def test_refresh_octane_source_fetches_only_stale_histories(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    class HistoryIncrementalClient(FakeOctaneClient):
        def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
            return [
                {"id": "D-FRESH", "name": "Fresh", "last_modified": "2026-06-10T00:00:00Z", "phase": {"name": "06"}},
                {"id": "D-STALE", "name": "Stale", "last_modified": "2026-06-12T00:00:00Z", "phase": {"name": "06"}},
                {"id": "D-MISSING", "name": "Missing", "last_modified": "2026-06-13T00:00:00Z", "phase": {"name": "06"}},
            ]

        def fetch_histories_for_defects(
            self,
            defect_ids: list[str],
            *,
            max_workers: int = 1,
            modified_since_by_defect: dict[str, str | None] | None = None,
        ) -> dict[str, dict[str, object]]:
            self.history_calls.append(list(defect_ids))
            return {
                defect_id: {
                    "data": [
                        {
                            "timestamp": "2026-06-14T00:00:00Z",
                            "change_set": [{"field_name": "phase", "old_value": "08", "value": "06"}],
                        }
                    ]
                }
                for defect_id in defect_ids
            }

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                comments TEXT,
                last_modified TEXT
            );
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT NOT NULL,
                event_timestamp TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                fetched_at TEXT NOT NULL
            );
            INSERT INTO octane_defects(defect_id, name, raw_json, fetched_at, last_modified)
            VALUES
                ('D-FRESH', 'old fresh', '{}', '2026-06-10T01:00:00Z', '2026-06-10T00:00:00Z'),
                ('D-STALE', 'old stale', '{}', '2026-06-10T01:00:00Z', '2026-06-10T00:00:00Z');
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES
                ('D-FRESH', '2026-06-10T00:00:00Z', 'phase', '08', '06', '2026-06-11T00:00:00Z'),
                ('D-STALE', '2026-06-10T00:00:00Z', 'phase', '08', '06', '2026-06-11T00:00:00Z');
            """
        )
        conn.commit()
    finally:
        conn.close()

    client = HistoryIncrementalClient()
    summary = refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("DTSV_China",),
            years=(2026,),
            include_history=True,
            include_comments=False,
            include_testing=False,
        ),
        client=client,
    )

    assert client.history_calls == [["D-MISSING", "D-STALE"]]
    assert summary["history_queued_defects"] == 2
    assert summary["history_skipped_defects"] == 1
    assert summary["history_event_rows"] == 2


def test_refresh_octane_source_fetches_incremental_history_window(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    class IncrementalHistoryClient(FakeOctaneClient):
        def __init__(self) -> None:
            super().__init__()
            self.history_since_calls: list[dict[str, str | None]] = []

        def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "D-STALE",
                    "name": "Stale defect",
                    "last_modified": "2026-06-12T00:00:00Z",
                    "phase": {"name": "06"},
                }
            ]

        def fetch_histories_for_defects(
            self,
            defect_ids: list[str],
            *,
            max_workers: int = 1,
            modified_since_by_defect: dict[str, str | None] | None = None,
        ) -> dict[str, dict[str, object]]:
            self.history_calls.append(list(defect_ids))
            self.history_since_calls.append(dict(modified_since_by_defect or {}))
            return {
                "D-STALE": {
                    "data": [
                        {
                            "timestamp": "2026-06-12T00:00:00Z",
                            "change_set": [{"field_name": "phase", "old_value": "08", "value": "06"}],
                        },
                    ]
                }
            }

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                comments TEXT,
                last_modified TEXT
            );
            CREATE TABLE octane_defect_history_events (
                defect_id TEXT NOT NULL,
                event_timestamp TEXT,
                field_name TEXT,
                old_value TEXT,
                new_value TEXT,
                fetched_at TEXT NOT NULL,
                action TEXT,
                user_name TEXT,
                team TEXT,
                entry_index INTEGER,
                change_index INTEGER,
                old_value_text TEXT,
                new_value_text TEXT,
                UNIQUE(defect_id, entry_index, change_index)
            );
            INSERT INTO octane_defects(defect_id, name, raw_json, fetched_at, last_modified)
            VALUES ('D-STALE', 'old stale', '{}', '2026-06-10T01:00:00Z', '2026-06-10T00:00:00Z');
            INSERT INTO octane_defect_history_events(
                defect_id, event_timestamp, field_name, old_value, new_value, fetched_at, entry_index, change_index
            ) VALUES ('D-STALE', '2026-06-10T00:00:00Z', 'phase', '10', '08', '2026-06-10T01:00:00Z', 0, 0);
            """
        )
        conn.commit()
    finally:
        conn.close()

    client = IncrementalHistoryClient()
    summary = refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("DTSV_China",),
            years=(2026,),
            include_history=True,
            include_comments=False,
            include_testing=False,
        ),
        client=client,
    )

    assert client.history_calls == [["D-STALE"]]
    assert client.history_since_calls == [{"D-STALE": "2026-06-10T00:00:00Z"}]
    assert summary["history_event_rows"] == 1

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT event_timestamp, old_value, new_value
            FROM octane_defect_history_events
            WHERE defect_id = 'D-STALE'
            ORDER BY event_timestamp
            """
        ).fetchall()
    finally:
        conn.close()

    assert rows == [
        ("2026-06-10T00:00:00Z", "10", "08"),
        ("2026-06-12T00:00:00Z", "08", "06"),
    ]


def test_refresh_octane_source_reuses_comments_for_unchanged_defects(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    class CommentIncrementalClient(FakeOctaneClient):
        def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "D-UNCHANGED",
                    "name": "Unchanged defect",
                    "last_modified": "2026-06-10T00:00:00Z",
                    "phase": {"name": "06"},
                },
                {
                    "id": "D-CHANGED",
                    "name": "Changed defect",
                    "last_modified": "2026-06-12T00:00:00Z",
                    "phase": {"name": "06"},
                },
            ]

        def fetch_comments_for_defects(self, defect_ids: list[str]) -> list[dict[str, object]]:
            self.comment_calls.append(list(defect_ids))
            return [{"defect_id": defect_id, "text": f"fresh {defect_id}"} for defect_id in defect_ids]

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                project TEXT,
                market TEXT,
                pu TEXT,
                fv TEXT,
                fvp TEXT,
                team TEXT,
                lead_model TEXT,
                raw_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                comments TEXT,
                last_modified TEXT
            );
            """
        )
        conn.executemany(
            "INSERT INTO octane_defects(defect_id, name, raw_json, fetched_at, comments, last_modified) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    "D-UNCHANGED",
                    "old unchanged",
                    "{}",
                    "2026-06-10T01:00:00Z",
                    json.dumps([{"text": "cached unchanged"}], ensure_ascii=False),
                    "2026-06-10T00:00:00Z",
                ),
                (
                    "D-CHANGED",
                    "old changed",
                    "{}",
                    "2026-06-10T01:00:00Z",
                    json.dumps([{"text": "stale changed"}], ensure_ascii=False),
                    "2026-06-10T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    client = CommentIncrementalClient()
    summary = refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("DTSV_China",),
            years=(2026,),
            include_history=False,
            include_comments=True,
            include_testing=False,
        ),
        client=client,
    )

    assert client.comment_calls == [["D-CHANGED"]]
    assert summary["comment_refreshed_defects"] == 1
    assert summary["comment_reused_defects"] == 1

    conn = sqlite3.connect(db_path)
    try:
        rows = dict(conn.execute("SELECT defect_id, comments FROM octane_defects ORDER BY defect_id").fetchall())
    finally:
        conn.close()

    assert "fresh D-CHANGED" in rows["D-CHANGED"]
    assert "cached unchanged" in rows["D-UNCHANGED"]


def test_refresh_octane_source_reuses_empty_comment_refresh_state(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"

    class EmptyCommentClient(FakeOctaneClient):
        def fetch_defects(self, *, team_id: str, year: int, modified_since: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "D-EMPTY",
                    "name": "Empty comment defect",
                    "last_modified": "2026-06-10T00:00:00Z",
                    "phase": {"name": "06"},
                }
            ]

        def fetch_comments_for_defects(self, defect_ids: list[str]) -> list[dict[str, object]]:
            self.comment_calls.append(list(defect_ids))
            return []

    client = EmptyCommentClient()
    for _run in range(2):
        refresh_octane_source(
            request=IngestRequest(
                source_db_path=db_path,
                teams=("DTSV_China",),
                years=(2026,),
                include_history=False,
                include_comments=True,
                include_testing=False,
            ),
            client=client,
        )

    assert client.comment_calls == [["D-EMPTY"]]


def test_refresh_octane_source_updates_legacy_comment_state_schema(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE octane_defect_comment_refresh_state (
                defect_id TEXT PRIMARY KEY,
                last_defect_modified TEXT NOT NULL,
                last_synced_at TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    client = FakeOctaneClient()
    refresh_octane_source(
        request=IngestRequest(
            source_db_path=db_path,
            teams=("DTSV_China",),
            years=(2026,),
            include_history=False,
            include_comments=True,
            include_testing=False,
        ),
        client=client,
    )

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT last_defect_modified, last_synced_at, defect_last_modified, refreshed_at, comments_json
            FROM octane_defect_comment_refresh_state
            WHERE defect_id = ?
            """,
            ("D-1-2026",),
        ).fetchone()
    finally:
        conn.close()

    assert row[0] == row[2]
    assert row[1] == row[3]
    assert "comment one" in row[4]


def test_refresh_octane_manual_runs_only_skips_testcase_rebuild(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    client = FakeOctaneClient()

    summary = refresh_octane_manual_runs_only(
        source_db_path=db_path,
        team_name="DTSV_China",
        years=(2026,),
        client=client,
    )

    assert summary == {"manual_run_rows": 1, "manual_run_ids": ["MR-1-2026"]}
    assert client.manual_run_calls == [
        {
            "team_id": "1",
            "year": 2026,
            "modified_since": None,
            "include_related_work_items": False,
        }
    ]

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM octane_testcase_relations").fetchone()[0] == 0
        run_row = conn.execute(
            "SELECT mr_id, team, run_team, release FROM octane_manual_runs WHERE mr_id = ?",
            ("MR-1-2026",),
        ).fetchone()
        assert run_row == ("MR-1-2026", "DTSV_China", "DTSV_China", "R-26-01")
    finally:
        conn.close()


def test_refresh_octane_manual_runs_only_reports_progress(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    client = FakeOctaneClient()
    messages: list[str] = []

    refresh_octane_manual_runs_only(
        source_db_path=db_path,
        team_name="DTSV_China",
        years=(2026,),
        client=client,
        progress=messages.append,
    )

    assert messages == [
        "Resolving Octane team: DTSV_China",
        "Resolved Octane team: DTSV_China (1)",
        "Refreshing manual runs for DTSV_China 2026 with full fetch",
        "manual-runs page year=2026",
        "Stored 1 manual runs for DTSV_China 2026",
    ]


def test_octane_client_list_teams_omits_query_param() -> None:
    captured: dict[str, Any] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"data": [{"id": "1", "name": "DTSV_China"}]}

    class FakeSession:
        def get(self, url: str, *, params: dict[str, object], timeout: int, verify: bool):
            captured["url"] = url
            captured["params"] = dict(params)
            captured["timeout"] = timeout
            captured["verify"] = verify
            return FakeResponse()

    client = OctaneApiClient(
        base_url="https://octane.example.com",
        shared_space_id="1002",
        workspace_id="2001",
        session=FakeSession(),
    )

    rows = client.list_teams()

    assert rows == [{"id": "1", "name": "DTSV_China"}]
    assert captured["params"] == {"fields": "id,name", "limit": 1000, "offset": 0}


def test_octane_client_fetch_comments_batches_unique_defect_ids_by_100() -> None:
    captured_queries: list[str] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"data": []}

    class FakeSession:
        def get(self, url: str, *, params: dict[str, object], timeout: int, verify: bool):
            captured_queries.append(str(params["query"]))
            return FakeResponse()

    client = OctaneApiClient(
        base_url="https://octane.example.com",
        shared_space_id="1002",
        workspace_id="2001",
        session=FakeSession(),
    )

    defect_ids = ["D-050", *[f"D-{index:03d}" for index in range(201)], "D-050"]

    rows = client.fetch_comments_for_defects(defect_ids)

    assert rows == []
    assert len(captured_queries) == 3
    assert captured_queries[0].count("D-") == 100
    assert captured_queries[1].count("D-") == 100
    assert captured_queries[2].count("D-") == 1


def test_octane_client_fetch_history_uses_legacy_history_logs_shape() -> None:
    captured: dict[str, Any] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"data": []}

    class FakeSession:
        def get(self, url: str, *, params: dict[str, object], timeout: int, verify: bool):
            captured["url"] = url
            captured["params"] = dict(params)
            captured["timeout"] = timeout
            captured["verify"] = verify
            return FakeResponse()

    client = OctaneApiClient(
        base_url="https://octane.example.com",
        shared_space_id="1002",
        workspace_id="2001",
        session=FakeSession(),
    )

    payload = client.fetch_history(defect_id="D-1")

    assert payload == {"data": [], "total_count": 0}
    assert captured["params"] == {
        "limit": 10000,
        "order_by": "-timestamp",
        "offset": 0,
        "query": '"(entity_id=\'D-1\';entity_type=\'defect\')"',
    }