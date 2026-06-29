from pathlib import Path
import sqlite3

import pytest

from backend.analytics.schema import ensure_schema
from backend.analytics.qgate_kpi_compare_report import (
    generate_qgate_kpi_compare_report,
)


def test_generate_qgate_kpi_compare_report_writes_expected_sections(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_compare_2024_2025.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-1",
                "D-1",
                "T-1",
                "Wake test",
                "Passed",
                "2024",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-1","status":{"name":"Passed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU and RSU","defect":{"total_count":1}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-2",
                "D-2",
                "T-2",
                "Wake test 2",
                "Failed",
                "2025",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-2","status":{"name":"Failed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU","defect":{"total_count":0}}',
                "2026-06-11T00:00:00Z",
            ),
        )
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
                '{"id":"D-1","year":"2024","phase":{"name":"06-Concluded"},"reporting_class_udf":{"data":[{"name":"Showstopper_Confirmed"}]},"problem_severity_udf":{"name":"customer irritated"},"blocking_reason_udf":{"name":"No release path"},"detected_by":{"full_name":"Tony Xie"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-2",
                "Ticket two",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-2","year":"2025","phase":{"name":"09-In Progress"},"reporting_class_udf":{"data":[{"name":"Showstopper_Candidate"}]},"problem_severity_udf":{"name":"customer irritated"},"blocking_reason_udf":{"name":"Validation blocked"},"detected_by":{"full_name":"Tony Xie"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    result = generate_qgate_kpi_compare_report(
        db_path=db_path,
        output_path=output_path,
        years=("2024", "2025"),
    )

    assert result == output_path
    html = output_path.read_text(encoding="utf-8")
    assert "2024 vs 2025 KPI Analysis" in html
    assert "A1. Core KPI Overview" in html
    assert "B1. Core Defect KPI Overview" in html
    assert "C1. Showstopper Confirmed" in html


def test_generate_qgate_kpi_compare_report_requires_defect_rows_for_each_year(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_compare_2024_2025.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-1",
                "D-1",
                "T-1",
                "Wake test",
                "Passed",
                "2024",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-1","status":{"name":"Passed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU and RSU","defect":{"total_count":1}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-2",
                "D-2",
                "T-2",
                "Wake test 2",
                "Failed",
                "2025",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-2","status":{"name":"Failed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU","defect":{"total_count":0}}',
                "2026-06-11T00:00:00Z",
            ),
        )
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
                '{"id":"D-1","year":"2024","phase":{"name":"06-Concluded"},"reporting_class_udf":{"data":[{"name":"Showstopper_Confirmed"}]},"problem_severity_udf":{"name":"customer irritated"},"blocking_reason_udf":{"name":"No release path"},"detected_by":{"full_name":"Tony Xie"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(ValueError, match="Missing defect rows for requested years: 2025"):
        generate_qgate_kpi_compare_report(
            db_path=db_path,
            output_path=output_path,
            years=("2024", "2025"),
        )