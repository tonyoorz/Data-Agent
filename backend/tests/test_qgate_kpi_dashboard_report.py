from pathlib import Path
import sqlite3

from backend.analytics.schema import ensure_schema
from backend.analytics.qgate_kpi_dashboard_report import (
    generate_qgate_kpi_dashboard_report,
)


def test_generate_qgate_kpi_dashboard_report_writes_expected_sections(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Ticket one",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-1","name":"Ticket one","year":"2025","phase":{"name":"09-In Progress"},"problem_finder_team_udf":{"name":"DTSV_China"},"reporting_class_udf":{"data":[{"name":"Showstopper_Confirmed"}]},"problem_severity_udf":{"name":"customer irritated"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-1",
                    "2025-01-01T00:00:00Z",
                    "phase",
                    "00-Draft",
                    "01-New",
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-1",
                    "2025-01-03T00:00:00Z",
                    "phase",
                    "01-New",
                    "09-In Progress",
                    "2026-06-11T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    result = generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    assert result == output_path
    assert output_path.exists()
    html = output_path.read_text(encoding="utf-8")
    assert "QGate KPI Dashboard" in html
    assert "A. Team Coverage" in html
    assert "B. Transition Analysis" in html
    assert "C. Phase Efficiency Summary" in html
    assert "DTSV_China" in html