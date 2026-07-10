from pathlib import Path
import json
import re
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
        conn.execute("ALTER TABLE octane_defects ADD COLUMN product_areas TEXT")
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


def test_generate_qgate_kpi_dashboard_report_defaults_year_filter_to_2026(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        defect_rows = [
            (
                "D-2025",
                "Ticket 2025",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-2025","name":"Ticket 2025","year":"2025","phase":{"name":"09-In Progress"},"problem_finder_team_udf":{"name":"DTSV_China"}}',
                "2026-06-11T00:00:00Z",
            ),
            (
                "D-2026",
                "Ticket 2026",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-2026","name":"Ticket 2026","year":"2026","phase":{"name":"09-In Progress"},"problem_finder_team_udf":{"name":"DTSV_China"}}',
                "2026-06-11T00:00:00Z",
            ),
        ]
        conn.executemany(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            defect_rows,
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-2025", "2025-01-01T00:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-2025", "2025-01-03T00:00:00Z", "phase", "01-New", "09-In Progress", "2026-06-11T00:00:00Z"),
                ("D-2026", "2026-01-01T00:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-2026", "2026-01-03T00:00:00Z", "phase", "01-New", "09-In Progress", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    assert "const DEFAULT_YEARS=QGATE_PAYLOAD.options.years.includes('2026')?['2026']" in html


def test_generate_qgate_kpi_dashboard_report_writes_interactive_payload_and_readable_phase_names(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("ALTER TABLE octane_defect_history_events ADD COLUMN old_value_text TEXT")
        conn.execute("ALTER TABLE octane_defect_history_events ADD COLUMN new_value_text TEXT")
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
                '{"id":"D-1","name":"Ticket one","year":"2025","phase":{"name":"02-In Pre-Analysis"},"problem_finder_team_udf":{"name":"DTSV_China"},"problem_finder_feature_udf":{"name":"Voice Interface [01.04.02.01.01.02]"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, old_value_text, new_value_text, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-1",
                    "2025-01-01T00:00:00Z",
                    "phase",
                    "phase.defect.new",
                    "phase.defect.opened",
                    "01-New",
                    "02-In Pre-Analysis",
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-1",
                    "2025-01-05T00:00:00Z",
                    "phase",
                    "phase.defect.opened",
                    "phase.defect.fixed",
                    "02-In Pre-Analysis",
                    "03-In Analysis",
                    "2026-06-11T00:00:00Z",
                ),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    assert "const QGATE_PAYLOAD =" in html
    assert "id=\"years-select\"" in html
    assert "id=\"coverage-bars\"" in html
    assert "id=\"grouped-stacked\"" in html
    assert "id=\"team-group-table\"" in html
    assert "id=\"fif-duration-bars\"" in html
    assert "id=\"fif-total-tickets\"" in html
    assert "function buildCoverageRows" in html
    assert "function buildSummary" in html
    assert "function renderGroupedViews" in html
    assert "function buildFifDurationRows" in html
    assert "function renderFifDurationChart" in html
    assert "selectedFifName" in html
    assert "DRILLDOWN_LIMIT=200" in html
    assert "scheduleRender" in html
    assert "fif-total-tickets" in html
    assert "Total tickets" in html
    assert "const drilldownIssues=state.fifPhaseTransition==='all'?filteredIssues:filteredIssues.filter(row=>row.Phase_Transition===state.fifPhaseTransition)" in html
    assert "Phase_Hours" in html
    assert "Duration_Days:(row.Phase_Hours/Math.max(row.Count,1))/24" in html
    assert "showing ${fmtNumber(visibleRows.length)}" in html
    assert "data-fif-name" in html
    assert "Ticket ID" in html
    assert "Defect Finder Team" in html
    assert "<th>Phase</th>" in html
    assert '<th class="num">Days</th>' in html
    assert "FiF Processing Time" in html
    assert "fif-horizontal-row" in html
    assert "fif-horizontal-track" in html
    assert "fif-bar-col" not in html
    assert "02-In Pre-Analysis -&gt; 03-In Analysis" in html
    assert "phase.defect.opened -&gt; phase.defect.fixed" not in html
    assert "Q-Gate" in html


def test_generate_qgate_kpi_dashboard_report_uses_global_china_fif_and_team_only_coverage(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("ALTER TABLE octane_defects ADD COLUMN product_areas TEXT")
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, requirement, requirements_json, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-FIF",
                "FiF ticket",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                "IuK_TSP_HMI Q-Gate.done",
                '["IuK_TSP_HMI Q-Gate.done"]',
                '{"id":"D-FIF","name":"FiF ticket","year":"2025"}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-FIF", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-FIF", "2025-01-03T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    payload_match = re.search(r"const QGATE_PAYLOAD = (.*?);\n", html)
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert "Global" in payload["options"]["fif"]
    assert payload["issues"]["columns"] == [
        "Year",
        "Team",
        "Ticket_ID",
        "Phase_Transition",
        "Group",
        "Duration_Hours",
        "Changed_By",
        "FiF",
        "FiF_Names",
        "Ticket_Timespan_Days",
    ]
    issue = dict(zip(payload["issues"]["columns"], payload["issues"]["rows"][0]))
    assert issue["FiF"] == "Global"
    assert isinstance(json.loads(issue["FiF_Names"]), list)
    assert "${row.Team} · ${row.Year}" not in html
    assert "${escapeHtml(row.Team)}</div>" in html


def test_generate_qgate_kpi_dashboard_report_classifies_china_specific_fif_by_function_tree(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, requirement, requirements_json, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-CHINA-EXACT",
                    "China exact ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    "Smart Access / Digital Key (Plus) [01.03.03.03.03]",
                    '["Smart Access / Digital Key (Plus) [01.03.03.03.03]"]',
                    '{"id":"D-CHINA-EXACT","name":"China exact ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-CHINA-CHILD",
                    "China child ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    "Some child function [01.04.03.01.03.06.03.99]",
                    '["Some child function [01.04.03.01.03.06.03.99]"]',
                    '{"id":"D-CHINA-CHILD","name":"China child ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-GLOBAL",
                    "Global ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    "IuK_TSP_HMI Q-Gate.done",
                    '["IuK_TSP_HMI Q-Gate.done"]',
                    '{"id":"D-GLOBAL","name":"Global ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-PRODUCT-AREA",
                    "Product area ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    "",
                    "[]",
                    '{"id":"D-PRODUCT-AREA","name":"Product area ticket","year":"2025","product_areas":{"data":[{"name":"Voice Interface [01.04.02.01.01.02]"}]}}',
                    "2026-06-11T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-CHINA-EXACT", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-CHINA-EXACT", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
                ("D-CHINA-CHILD", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-CHINA-CHILD", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
                ("D-GLOBAL", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-GLOBAL", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
                ("D-PRODUCT-AREA", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-PRODUCT-AREA", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    payload_match = re.search(r"const QGATE_PAYLOAD = (.*?);\n", html)
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    issue_rows = [dict(zip(payload["issues"]["columns"], row)) for row in payload["issues"]["rows"]]
    fif_by_ticket = {row["Ticket_ID"]: row["FiF"] for row in issue_rows}
    fif_names_by_ticket = {row["Ticket_ID"]: json.loads(row["FiF_Names"]) for row in issue_rows}
    assert fif_by_ticket["D-CHINA-EXACT"] == "China Specific"
    assert "Smart Access / Digital Key (Plus) [01.03.03.03.03]" in fif_names_by_ticket["D-CHINA-EXACT"]
    assert fif_by_ticket["D-CHINA-CHILD"] == "China Specific"
    assert "Some child function [01.04.03.01.03.06.03.99]" in fif_names_by_ticket["D-CHINA-CHILD"]
    assert fif_by_ticket["D-PRODUCT-AREA"] == "China Specific"
    assert "Voice Interface [01.04.02.01.01.02]" in fif_names_by_ticket["D-PRODUCT-AREA"]
    assert fif_by_ticket["D-GLOBAL"] == "Global"
    assert fif_names_by_ticket["D-GLOBAL"] == ["IuK_TSP_HMI Q-Gate.done"]


def test_generate_qgate_kpi_dashboard_report_prefers_product_areas_column_for_fif(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("ALTER TABLE octane_defects ADD COLUMN product_areas TEXT")
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, product_areas, requirement, requirements_json, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-PRODUCT-COLUMN",
                "Product column ticket",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                "Voice Interface Variant",
                "IuK_TSP_HMI Q-Gate.done",
                '["IuK_TSP_HMI Q-Gate.done"]',
                '{"id":"D-PRODUCT-COLUMN","name":"Product column ticket","year":"2025"}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-PRODUCT-COLUMN", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-PRODUCT-COLUMN", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    payload_match = re.search(r"const QGATE_PAYLOAD = (.*?);\n", html)
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    issue_rows = [dict(zip(payload["issues"]["columns"], row)) for row in payload["issues"]["rows"]]
    issue = issue_rows[0]
    assert issue["FiF"] == "China Specific"
    assert json.loads(issue["FiF_Names"]) == ["Voice Interface Variant"]


def test_generate_qgate_kpi_dashboard_report_excludes_weekends_from_durations(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("ALTER TABLE octane_defects ADD COLUMN product_areas TEXT")
        conn.executemany(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-FRI-MON",
                    "Friday to Monday ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    '{"id":"D-FRI-MON","name":"Friday to Monday ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-WEEKEND",
                    "Weekend ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    '{"id":"D-WEEKEND","name":"Weekend ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-CROSS-YEAR",
                    "Cross year ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    '{"id":"D-CROSS-YEAR","name":"Cross year ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-FRI-MON", "2025-01-03T10:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-FRI-MON", "2025-01-06T10:00:00Z", "phase", "01-New", "09-Concluded without action", "2026-06-11T00:00:00Z"),
                ("D-WEEKEND", "2025-01-04T10:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-WEEKEND", "2025-01-05T10:00:00Z", "phase", "01-New", "09-Concluded without action", "2026-06-11T00:00:00Z"),
                ("D-CROSS-YEAR", "2025-12-31T10:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-CROSS-YEAR", "2026-01-05T10:00:00Z", "phase", "01-New", "09-Concluded without action", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    payload_match = re.search(r"const QGATE_PAYLOAD = (.*?);\n", html)
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    issue_rows = [dict(zip(payload["issues"]["columns"], row)) for row in payload["issues"]["rows"]]
    by_ticket = {row["Ticket_ID"]: row for row in issue_rows}
    assert by_ticket["D-FRI-MON"]["Duration_Hours"] == 24.0
    assert by_ticket["D-FRI-MON"]["Ticket_Timespan_Days"] == 1.0
    assert by_ticket["D-WEEKEND"]["Duration_Hours"] == 0.0
    assert by_ticket["D-WEEKEND"]["Ticket_Timespan_Days"] == 0.0
    assert by_ticket["D-CROSS-YEAR"]["Duration_Hours"] == 72.0
    assert by_ticket["D-CROSS-YEAR"]["Ticket_Timespan_Days"] == 3.0


def test_generate_qgate_kpi_dashboard_report_uses_legacy_source_phase_grouping(
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
                "D-GROUP",
                "Grouping ticket",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-GROUP","name":"Grouping ticket","year":"2025"}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-GROUP", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-GROUP", "2025-01-02T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
                ("D-GROUP", "2025-01-03T00:00:00Z", "phase", "03-In Analysis", "04-In Progress", "2026-06-11T00:00:00Z"),
                ("D-GROUP", "2025-01-04T00:00:00Z", "phase", "04-In Progress", "09-Concluded without action", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    payload_match = re.search(r"const QGATE_PAYLOAD = (.*?);\n", html)
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    issue_rows = [dict(zip(payload["issues"]["columns"], row)) for row in payload["issues"]["rows"]]
    assert {row["Phase_Transition"]: row["Group"] for row in issue_rows} == {
        "02-In Pre-Analysis -> 03-In Analysis": "Q-Gate",
        "03-In Analysis -> 04-In Progress": "CoC",
        "04-In Progress -> 09-Concluded without action": "CoC",
    }


def test_generate_qgate_kpi_dashboard_report_prefers_legacy_qgate_team_scope(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "D-LEGACY",
                    "Legacy team ticket",
                    "DTSV_China",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    '{"id":"D-LEGACY","name":"Legacy team ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
                (
                    "D-OTHER",
                    "Other team ticket",
                    "DIPS",
                    "MGU",
                    "China",
                    "ICV",
                    "Speech",
                    "Tony",
                    "NA5",
                    '{"id":"D-OTHER","name":"Other team ticket","year":"2025"}',
                    "2026-06-11T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-LEGACY", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-LEGACY", "2025-01-03T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
                ("D-OTHER", "2025-01-01T00:00:00Z", "phase", "01-New", "02-In Pre-Analysis", "2026-06-11T00:00:00Z"),
                ("D-OTHER", "2025-01-03T00:00:00Z", "phase", "02-In Pre-Analysis", "03-In Analysis", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    html = output_path.read_text(encoding="utf-8")
    assert "DTSV_China" in html
    assert "DIPS" not in html
    assert "D-OTHER" not in html
    assert '"history_success_rate":100.0' in html