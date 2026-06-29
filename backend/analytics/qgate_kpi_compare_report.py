from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
import json
import sqlite3

from backend.analytics.qgate_kpi_report_common import (
    escape_html,
    require_tables,
    resolve_report_db_path,
)


def _parse_json(value: object) -> dict[str, object]:
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _extract_named_value(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or value.get("full_name") or "").strip()
    return str(value or "").strip()


def _extract_reporting_class_names(payload: dict[str, object]) -> set[str]:
    reporting_class = payload.get("reporting_class_udf")
    if not isinstance(reporting_class, dict):
        return set()

    raw_items = reporting_class.get("data")
    if not isinstance(raw_items, list):
        return set()

    names: set[str] = set()
    for raw_item in raw_items:
        name = _extract_named_value(raw_item).strip()
        if name:
            names.add(name)
    return names


def _extract_project_tokens(project_text: str) -> list[str]:
    tokens: list[str] = []
    normalized = project_text.replace("&", ",").replace(" and ", ",")
    for candidate in normalized.split(","):
        token = candidate.strip()
        if token:
            tokens.append(token)
    return tokens or ["Unknown"]


def _counted_table_rows(counter: Counter[str]) -> str:
    if not counter:
        return '<tr><td colspan="2">No data</td></tr>'
    return "".join(
        f"<tr><td>{escape_html(name)}</td><td>{count}</td></tr>"
        for name, count in counter.most_common()
    )


def _build_yearly_kpi_rows(stats_by_year: dict[str, dict[str, int]], years: tuple[str, str]) -> str:
    rows: list[str] = []
    for year in years:
        stats = stats_by_year[year]
        total = stats["total"]
        passed = stats["passed"]
        failed = stats["failed"]
        requires_attention = stats["requires_attention"]
        passed_rate = (passed / total * 100.0) if total else 0.0
        failed_rate = (failed / total * 100.0) if total else 0.0
        attention_rate = (requires_attention / total * 100.0) if total else 0.0
        rows.append(
            "".join(
                (
                    f"<tr><td>{escape_html(year)}</td>",
                    f"<td>{total}</td>",
                    f"<td>{passed}</td>",
                    f"<td>{passed_rate:.1f}%</td>",
                    f"<td>{failed}</td>",
                    f"<td>{failed_rate:.1f}%</td>",
                    f"<td>{requires_attention}</td>",
                    f"<td>{attention_rate:.1f}%</td></tr>",
                )
            )
        )
    return "".join(rows)


def _build_yearly_defect_rows(stats_by_year: dict[str, dict[str, int]], years: tuple[str, str]) -> str:
    return "".join(
        f"<tr><td>{escape_html(year)}</td><td>{stats_by_year[year]['total']}</td><td>{stats_by_year[year]['bi4_and_below']}</td><td>{stats_by_year[year]['showstopper_confirmed']}</td><td>{stats_by_year[year]['preventing_maturity']}</td><td>{stats_by_year[year]['showstopper_candidate']}</td><td>{stats_by_year[year]['phase_06_concluded']}</td></tr>"
        for year in years
    )


def _build_comparison_tables(
    *,
    years: tuple[str, str],
    run_stats: dict[str, dict[str, int]],
    project_counts: dict[str, Counter[str]],
    model_counts: dict[str, Counter[str]],
    defect_linkage: dict[str, dict[str, int]],
    defect_stats: dict[str, dict[str, int]],
    blocking_reason_counts: Counter[str],
    color_cluster_counts: Counter[str],
    ticket_matrix_counts: Counter[str],
    submitter_counts: Counter[str],
    showstopper_team_counts: Counter[str],
    phase_09_team_counts: Counter[str],
) -> str:
    year_window = f"{years[0]} vs {years[1]}"
    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>{escape_html(years[0])} vs {escape_html(years[1])} KPI Analysis</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: Segoe UI, Arial, sans-serif;
      background: #f5f7fb;
      color: #162033;
    }}
    body {{ margin: 0; padding: 32px; background: linear-gradient(180deg, #edf3ff 0%, #f8fbff 100%); }}
    main {{ max-width: 1200px; margin: 0 auto; }}
    section {{ background: #ffffff; border: 1px solid #d8e1f0; border-radius: 16px; padding: 20px; margin-top: 18px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.06); }}
    h1 {{ margin: 0 0 8px; }}
    h2 {{ margin-bottom: 12px; }}
    p {{ margin: 8px 0 0; }}
    .summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }}
    .card {{ background: #102542; color: #f8fbff; border-radius: 14px; padding: 16px; }}
    .metric {{ font-size: 28px; font-weight: 700; margin-top: 4px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
    th, td {{ padding: 10px 12px; border-bottom: 1px solid #e6ebf2; text-align: left; vertical-align: top; }}
    th {{ background: #f7f9fc; }}
  </style>
</head>
<body>
  <main>
    <h1>{escape_html(year_window)} KPI Analysis</h1>
    <p>Native static compare report generated from octane_manual_runs and octane_defects.</p>

    <section>
      <div class=\"summary\">
        <div class=\"card\"><div>{escape_html(years[0])} executions</div><div class=\"metric\">{run_stats[years[0]]['total']}</div></div>
        <div class=\"card\"><div>{escape_html(years[1])} executions</div><div class=\"metric\">{run_stats[years[1]]['total']}</div></div>
        <div class=\"card\"><div>{escape_html(years[0])} defects</div><div class=\"metric\">{defect_stats[years[0]]['total']}</div></div>
        <div class=\"card\"><div>{escape_html(years[1])} defects</div><div class=\"metric\">{defect_stats[years[1]]['total']}</div></div>
      </div>
    </section>

    <section>
      <h2>A1. Core KPI Overview</h2>
      <table>
        <thead><tr><th>Year</th><th>Total executions</th><th>Passed</th><th>Passed rate</th><th>Failed</th><th>Failed rate</th><th>Requires Attention</th><th>Requires Attention rate</th></tr></thead>
        <tbody>{_build_yearly_kpi_rows(run_stats, years)}</tbody>
      </table>
    </section>

    <section class=\"grid\">
      <div>
        <h2>A2. Project Coverage</h2>
        <table><thead><tr><th>Project</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(project_counts[years[0]] + project_counts[years[1]])}</tbody></table>
      </div>
      <div>
        <h2>A3. Model Coverage</h2>
        <table><thead><tr><th>Model</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(model_counts[years[0]] + model_counts[years[1]])}</tbody></table>
      </div>
    </section>

    <section>
      <h2>A4. Test Execution and Defect Linkage</h2>
      <table>
        <thead><tr><th>Year</th><th>Linked executions</th><th>Linked rate</th><th>Linked Failed</th><th>Linked Passed</th></tr></thead>
        <tbody>
          <tr><td>{escape_html(years[0])}</td><td>{defect_linkage[years[0]]['linked']}</td><td>{(defect_linkage[years[0]]['linked'] / run_stats[years[0]]['total'] * 100.0) if run_stats[years[0]]['total'] else 0.0:.1f}%</td><td>{defect_linkage[years[0]]['failed']}</td><td>{defect_linkage[years[0]]['passed']}</td></tr>
          <tr><td>{escape_html(years[1])}</td><td>{defect_linkage[years[1]]['linked']}</td><td>{(defect_linkage[years[1]]['linked'] / run_stats[years[1]]['total'] * 100.0) if run_stats[years[1]]['total'] else 0.0:.1f}%</td><td>{defect_linkage[years[1]]['failed']}</td><td>{defect_linkage[years[1]]['passed']}</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>B1. Core Defect KPI Overview</h2>
      <table>
        <thead><tr><th>Year</th><th>Total defects</th><th>BI-4 and below</th><th>Showstopper Confirmed</th><th>Preventing Maturity</th><th>Showstopper Candidate</th><th>06-Concluded</th></tr></thead>
        <tbody>{_build_yearly_defect_rows(defect_stats, years)}</tbody>
      </table>
    </section>

    <section class=\"grid\">
      <div>
        <h2>B2. CWA Blocking Reason Distribution</h2>
        <table><thead><tr><th>Blocking reason</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(blocking_reason_counts)}</tbody></table>
      </div>
      <div>
        <h2>B3. CWA Three-Color Cluster</h2>
        <table><thead><tr><th>Cluster</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(color_cluster_counts)}</tbody></table>
      </div>
      <div>
        <h2>B4. Ticket Matrix Distribution</h2>
        <table><thead><tr><th>Matrix slice</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(ticket_matrix_counts)}</tbody></table>
      </div>
      <div>
        <h2>B5. Top 15 Submitters</h2>
        <table><thead><tr><th>Submitter</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(Counter(dict(submitter_counts.most_common(15))))}</tbody></table>
      </div>
    </section>

    <section class=\"grid\">
      <div>
        <h2>C1. Showstopper Confirmed</h2>
        <table><thead><tr><th>Team</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(showstopper_team_counts)}</tbody></table>
      </div>
      <div>
        <h2>C2. Phase 09 (CWA)</h2>
        <table><thead><tr><th>Team</th><th>Count</th></tr></thead><tbody>{_counted_table_rows(phase_09_team_counts)}</tbody></table>
      </div>
    </section>
  </main>
</body>
</html>"""


def generate_qgate_kpi_compare_report(
    *,
    db_path: str | Path | None = None,
    output_path: str | Path,
    years: tuple[str, str] = ("2024", "2025"),
) -> Path:
    resolved_db_path = resolve_report_db_path(db_path)
    resolved_output_path = Path(output_path)
    require_tables(resolved_db_path, ("octane_manual_runs", "octane_defects"))

    conn = sqlite3.connect(str(resolved_db_path))
    try:
        manual_run_rows = conn.execute(
            """
            SELECT mr_id, defect_id, status, year, project, lead_model, raw_json
            FROM octane_manual_runs
            WHERE year IN (?, ?)
            ORDER BY mr_id
            """,
            years,
        ).fetchall()
        defect_rows = conn.execute(
            "SELECT defect_id, team, project, raw_json FROM octane_defects ORDER BY defect_id"
        ).fetchall()
    finally:
        conn.close()

    if not manual_run_rows:
        raise ValueError(
            f"No manual run rows found for requested years: {', '.join(years)}"
        )

    observed_years = {str(row[3] or "").strip() for row in manual_run_rows}
    missing_years = [year for year in years if year not in observed_years]
    if missing_years:
        raise ValueError(
            f"Missing manual run rows for requested years: {', '.join(missing_years)}"
        )

    run_stats = {
        year: {"total": 0, "passed": 0, "failed": 0, "requires_attention": 0}
        for year in years
    }
    project_counts = {year: Counter() for year in years}
    model_counts = {year: Counter() for year in years}
    defect_linkage = {
        year: {"linked": 0, "failed": 0, "passed": 0}
        for year in years
    }

    for _mr_id, defect_id, status, year, project, lead_model, raw_json in manual_run_rows:
        year_text = str(year or "").strip()
        payload = _parse_json(raw_json)
        status_name = _extract_named_value(payload.get("status")) or str(status or "").strip()
        normalized_status = status_name.casefold()
        run_stats[year_text]["total"] += 1
        if normalized_status == "passed":
            run_stats[year_text]["passed"] += 1
        elif normalized_status == "failed":
            run_stats[year_text]["failed"] += 1
        else:
            run_stats[year_text]["requires_attention"] += 1

        raw_project = payload.get("target_ecu_conf_udf")
        project_text = str(raw_project or project or "Unknown").strip()
        for token in _extract_project_tokens(project_text):
            project_counts[year_text][token] += 1

        model_text = _extract_named_value(payload.get("exec_model_series_udf")) or str(lead_model or "Unknown").strip() or "Unknown"
        model_counts[year_text][model_text] += 1

        raw_defect = payload.get("defect")
        linked = False
        if isinstance(raw_defect, dict):
            linked = int(raw_defect.get("total_count") or 0) > 0
        if not linked and str(defect_id or "").strip():
            linked = True
        if linked:
            defect_linkage[year_text]["linked"] += 1
            if normalized_status == "failed":
                defect_linkage[year_text]["failed"] += 1
            if normalized_status == "passed":
                defect_linkage[year_text]["passed"] += 1

    defect_stats = {
        year: {
            "total": 0,
            "bi4_and_below": 0,
            "showstopper_confirmed": 0,
            "preventing_maturity": 0,
            "showstopper_candidate": 0,
            "phase_06_concluded": 0,
        }
        for year in years
    }
    blocking_reason_counts: Counter[str] = Counter()
    color_cluster_counts: Counter[str] = Counter()
    ticket_matrix_counts: Counter[str] = Counter()
    submitter_counts: Counter[str] = Counter()
    showstopper_team_counts: Counter[str] = Counter()
    phase_09_team_counts: Counter[str] = Counter()
    cross_team_year = years[-1]
    observed_defect_years: set[str] = set()

    for _defect_id, team, project, raw_json in defect_rows:
        payload = _parse_json(raw_json)
        year_text = str(payload.get("year") or "").strip()
        if year_text not in defect_stats:
            continue

        observed_defect_years.add(year_text)

        defect_stats[year_text]["total"] += 1

        severity = _extract_named_value(payload.get("problem_severity_udf")).casefold()
        if severity and (
            "bi-1" in severity
            or "bi-2" in severity
            or "bi-3" in severity
            or "bi-4" in severity
            or "customer" in severity
        ):
            defect_stats[year_text]["bi4_and_below"] += 1

        reporting_classes = {name.casefold() for name in _extract_reporting_class_names(payload)}
        if "showstopper_confirmed" in reporting_classes:
            defect_stats[year_text]["showstopper_confirmed"] += 1
            if year_text == cross_team_year:
                showstopper_team_counts[str(team or "Unknown").strip() or "Unknown"] += 1

        if "showstopper_candidate" in reporting_classes:
            defect_stats[year_text]["showstopper_candidate"] += 1

        blocking_reason = _extract_named_value(payload.get("blocking_reason_udf"))
        if blocking_reason:
            defect_stats[year_text]["preventing_maturity"] += 1
            blocking_reason_counts[blocking_reason] += 1

        phase_name = _extract_named_value(payload.get("phase"))
        if phase_name == "06-Concluded":
            defect_stats[year_text]["phase_06_concluded"] += 1
        if year_text == cross_team_year and phase_name.startswith("09"):
            phase_09_team_counts[str(team or "Unknown").strip() or "Unknown"] += 1

        if not severity:
            color_cluster = "Unknown"
        elif "customer" in severity or "bi-1" in severity or "bi-2" in severity:
            color_cluster = "Red"
        elif "irritated" in severity or "bi-3" in severity or "bi-4" in severity:
            color_cluster = "Yellow"
        else:
            color_cluster = "Green"
        color_cluster_counts[color_cluster] += 1

        project_name = str(project or "Unknown").strip() or "Unknown"
        ticket_matrix_counts[f"{year_text} / {project_name} / {phase_name or 'Unknown'}"] += 1

        submitter = _extract_named_value(payload.get("detected_by")) or "Unknown"
        submitter_counts[submitter] += 1

    missing_defect_years = [year for year in years if year not in observed_defect_years]
    if missing_defect_years:
        raise ValueError(
            f"Missing defect rows for requested years: {', '.join(missing_defect_years)}"
        )

    html = _build_comparison_tables(
        years=years,
        run_stats=run_stats,
        project_counts=project_counts,
        model_counts=model_counts,
        defect_linkage=defect_linkage,
        defect_stats=defect_stats,
        blocking_reason_counts=blocking_reason_counts,
        color_cluster_counts=color_cluster_counts,
        ticket_matrix_counts=ticket_matrix_counts,
        submitter_counts=submitter_counts,
        showstopper_team_counts=showstopper_team_counts,
        phase_09_team_counts=phase_09_team_counts,
    )
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(html, encoding="utf-8")
    return resolved_output_path