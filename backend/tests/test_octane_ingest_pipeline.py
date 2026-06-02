from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from backend.analytics.ingest.client import OctaneApiClient
from backend.analytics.ingest.pipeline import IngestRequest, refresh_octane_manual_runs_only, refresh_octane_source


class FakeOctaneClient:
    def __init__(self) -> None:
        self.manual_run_calls: list[dict[str, object]] = []

    def list_teams(self) -> list[dict[str, str]]:
        return [
            {"id": "1", "name": "DTSV_China"},
            {"id": "2", "name": "[AT]CoC_EI_IuK"},
        ]

    def fetch_defects(self, *, team_id: str, year: int) -> list[dict[str, object]]:
        return [
            {
                "id": f"D-{team_id}-{year}",
                "name": "Wake defect",
                "phase": {"name": "06"},
            }
        ]

    def fetch_comments_for_defects(self, defect_ids: list[str]) -> list[dict[str, object]]:
        return [{"defect_id": defect_ids[0], "text": "comment one"}]

    def fetch_history(self, *, defect_id: str) -> dict[str, object]:
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


def test_refresh_octane_manual_runs_only_skips_testcase_rebuild(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    client = FakeOctaneClient()

    summary = refresh_octane_manual_runs_only(
        source_db_path=db_path,
        team_name="DTSV_China",
        years=(2026,),
        client=client,
    )

    assert summary == {"manual_run_rows": 1}
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


def test_octane_client_fetch_history_requests_minimal_fields() -> None:
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
        "fields": "timestamp,action,user{full_name,name},change_set{field_name,old_value,new_value,value,old_value_text,new_value_text,value_text}",
        "limit": 10000,
        "offset": 0,
        "query": '"(entity_id=\'D-1\';entity_type=\'defect\')"',
    }