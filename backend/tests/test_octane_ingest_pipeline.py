from __future__ import annotations

import sqlite3
from pathlib import Path

from backend.analytics.ingest.pipeline import IngestRequest, refresh_octane_source


class FakeOctaneClient:
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

    def fetch_manual_runs(self, *, team_id: str, year: int) -> list[dict[str, object]]:
        return [
            {
                "id": f"MR-{team_id}-{year}",
                "defect": {"id": f"D-{team_id}-{year}"},
                "test": {"id": f"T-{team_id}-{year}"},
                "test_name": "Wake test",
                "status": "Passed",
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
        "testcase_relation_rows": 2,
    }

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM octane_defects").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_defect_history_events").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_manual_runs").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_testcases").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM octane_testcase_relations").fetchone()[0] == 2
    finally:
        conn.close()