from __future__ import annotations

import sqlite3

from backend.analytics.qgate_weekly_report import build_qgate_weekly_report_payload


def _create_weekly_report_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE octane_defects (
            defect_id TEXT PRIMARY KEY,
            name TEXT,
            creation_time TEXT,
            last_modified TEXT,
            problem_finder_team TEXT,
            owner TEXT,
            project TEXT,
            lead_model TEXT,
            phase TEXT,
            status_phase TEXT,
            reporting_class TEXT,
            problem_severity TEXT,
            year TEXT,
            fetched_at TEXT,
            raw_json TEXT NOT NULL
        );
        CREATE TABLE octane_manual_runs (
            mr_id TEXT PRIMARY KEY,
            test_id TEXT,
            test_name TEXT,
            status TEXT,
            year TEXT,
            test_week TEXT,
            project TEXT,
            pu TEXT,
            tester TEXT,
            started TEXT,
            finished TEXT,
            raw_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        );
        """
    )
    conn.executemany(
        """
        INSERT INTO octane_defects(
            defect_id, name, creation_time, last_modified, problem_finder_team, owner,
            project, lead_model, phase, status_phase, reporting_class, problem_severity,
            year, fetched_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "D-1",
                "Verify speech wakeup",
                "2026-06-01T08:00:00Z",
                "2026-06-08T08:00:00Z",
                "PMG Validation",
                "Alice",
                "IDCEVO",
                "G70",
                "08-In Verification",
                "08-In Verification",
                "Management decision",
                "05-unsatisfactory",
                "2026",
                "2026-06-08T08:00:00Z",
                "{}",
            ),
            (
                "D-2",
                "Reject stale issue",
                "2026-06-02T08:00:00Z",
                "2026-06-09T08:00:00Z",
                "SHK Validation",
                "Bob",
                "IDCEVO",
                "G70",
                "09-Concluded without action",
                "09-Concluded without action",
                "Not reproducible",
                "04-deficient",
                "2026",
                "2026-06-09T08:00:00Z",
                "{}",
            ),
            (
                "D-3",
                "IDC verify navigation",
                "2026-06-03T08:00:00Z",
                "2026-06-10T08:00:00Z",
                "SHK Validation",
                "Alice",
                "IDC",
                "G68",
                "08-In Verification",
                "08-In Verification",
                "Additional Information necessary",
                "06-customer irritated",
                "2026",
                "2026-06-10T08:00:00Z",
                "{}",
            ),
        ],
    )
    conn.executemany(
        """
        INSERT INTO octane_manual_runs(
            mr_id, test_id, test_name, status, year, test_week, project, pu,
            tester, started, finished, raw_json, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            ("MR-1", "T-1", "Wakeup smoke", "Passed", "2026", "2026-CW24", "IDCEVO", "26-07", "Alice", "2026-06-10T08:00:00Z", "2026-06-10T10:00:00Z", "{}", "2026-06-10T10:00:00Z"),
            ("MR-2", "T-2", "Wakeup regression", "Failed", "2026", "2026-CW24", "IDCEVO", "26-07", "Bob", "2026-06-10T08:00:00Z", "2026-06-10T09:30:00Z", "{}", "2026-06-10T09:30:00Z"),
            ("MR-3", "T-1", "Wakeup smoke", "Passed", "2026", "2026-CW25", "IDCEVO", "26-11", "Alice", "2026-06-17T08:00:00Z", "2026-06-17T11:00:00Z", "{}", "2026-06-17T11:00:00Z"),
            ("MR-4", "T-3", "Navigation route", "Requires Attention", "2026", "2026-CW25", "IDC", "26-11", "Chen", "2026-06-18T08:00:00Z", "2026-06-18T09:00:00Z", "{}", "2026-06-18T09:00:00Z"),
            ("MR-5", "T-4", "Planned route", "Planned", "2026", "Future Planning", "IDC", "26-07", "Chen", "", "", "{}", "2026-06-18T09:00:00Z"),
            ("MR-6", "T-5", "Planned wakeup", "Planned", "2026", "2026-CW26", "IDCEVO", "26-11", "Alice", "", "", "{}", "2026-06-18T09:00:00Z"),
        ],
    )
    conn.commit()
    conn.close()


def test_build_qgate_weekly_report_payload_aggregates_defect_and_test_sections(tmp_path):
    db_path = tmp_path / "qgate_raw.db"
    _create_weekly_report_db(db_path)

    payload = build_qgate_weekly_report_payload(db_path=db_path, year="2026")

    assert payload["overview"] == {
        "defect_total": 3,
        "in_verification_total": 2,
        "rejected_total": 1,
        "manual_run_total": 6,
        "planned_total": 2,
    }
    assert payload["defect_quality_rows"] == [
        {"project": "IDCEVO", "lead_model": "G70", "pmg": 1, "shk": 1, "total": 2},
        {"project": "IDC", "lead_model": "G68", "pmg": 0, "shk": 1, "total": 1},
    ]
    assert payload["defect_owner_rows"] == [
        {"owner": "Alice", "in_verification": 2, "rejected": 0, "total": 2},
        {"owner": "Bob", "in_verification": 0, "rejected": 1, "total": 1},
    ]
    assert payload["rejected_reason_rows"] == [
        {"reason": "Not reproducible", "count": 1},
    ]
    assert payload["test_case_tendency_rows"] == [
        {"test_week": "2026-CW24", "test_cases": 2, "manual_runs": 2},
        {"test_week": "2026-CW25", "test_cases": 2, "manual_runs": 2},
        {"test_week": "2026-CW26", "test_cases": 1, "manual_runs": 1},
    ]
    assert payload["last_week_status_rows"] == [
        {"project": "IDC", "passed": 0, "failed": 0, "requires_attention": 1, "planned": 0, "other": 0, "total": 1},
        {"project": "IDCEVO", "passed": 1, "failed": 0, "requires_attention": 0, "planned": 0, "other": 0, "total": 1},
    ]
    assert payload["test_effort_rows"] == [
        {"project": "IDCEVO", "test_hours": 3.0, "manual_runs": 1},
        {"project": "IDC", "test_hours": 1.0, "manual_runs": 1},
    ]
    assert payload["incoming_test_case_rows"] == [
        {"project": "IDC", "pu": "26-07", "planned": 1},
        {"project": "IDCEVO", "pu": "26-11", "planned": 1},
    ]