from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from pathlib import Path
import json
import sqlite3

from backend.analytics.qgate_kpi_report_common import (
    escape_html,
    require_tables,
    resolve_report_db_path,
)


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _extract_team(team: object, raw_json: object) -> str:
    team_name = str(team or "").strip()
    if team_name:
        return team_name
    if not raw_json:
        return "Unknown"
    try:
        payload = json.loads(str(raw_json))
    except json.JSONDecodeError:
        return "Unknown"

    raw_team = payload.get("problem_finder_team_udf")
    if isinstance(raw_team, dict):
        resolved = str(raw_team.get("name") or "").strip()
        if resolved:
            return resolved
    return "Unknown"


def _extract_phase_group(phase_name: object) -> str:
    phase_text = str(phase_name or "").strip()
    phase_prefix = phase_text[:2]
    if phase_prefix in {"02", "07"}:
        return "Q-Gate"
    if phase_prefix in {"00", "01", "06", "08", "09"}:
        return "Integration"
    if phase_prefix in {"03", "04", "05"}:
        return "CoC"
    return "Other"


def _build_html(
    *,
    team_counts: dict[str, int],
    transition_rows: list[tuple[str, str, int, float]],
    efficiency_rows: list[tuple[str, str, int, float]],
    scoped_defects: int,
) -> str:
    team_lines = "".join(
        f"<tr><td>{escape_html(team)}</td><td>{count}</td><td>{count}</td><td>0</td><td>100.0%</td></tr>"
        for team, count in sorted(team_counts.items())
    )
    transition_lines = "".join(
        f"<tr><td>{escape_html(name)}</td><td>{escape_html(group)}</td><td>{samples}</td><td>{avg_days:.1f}</td></tr>"
        for name, group, samples, avg_days in transition_rows
    )
    efficiency_lines = "".join(
        f"<tr><td>{escape_html(team)}</td><td>{escape_html(group)}</td><td>{tickets}</td><td>{avg_days:.1f}</td></tr>"
        for team, group, tickets, avg_days in efficiency_rows
    )
    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>QGate KPI Dashboard</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: Segoe UI, Arial, sans-serif;
      background: #f6f8fb;
      color: #1b1f24;
    }}
    body {{ margin: 0; padding: 32px; background: linear-gradient(180deg, #eef4ff 0%, #f8fafc 100%); }}
    main {{ max-width: 1100px; margin: 0 auto; }}
    h1 {{ margin-bottom: 8px; }}
    section {{ background: #ffffff; border: 1px solid #d8e0eb; border-radius: 14px; padding: 20px; margin-top: 18px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }}
    .summary {{ display: flex; gap: 16px; flex-wrap: wrap; }}
    .card {{ min-width: 180px; background: #0f172a; color: #f8fafc; border-radius: 12px; padding: 16px; }}
    .metric {{ font-size: 28px; font-weight: 700; margin-top: 6px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
    th, td {{ padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }}
    th {{ background: #f8fafc; }}
  </style>
</head>
<body>
  <main>
    <h1>QGate KPI Dashboard</h1>
    <p>Native static dashboard report generated from octane_defects and octane_defect_history_events.</p>

    <section>
      <div class=\"summary\">
        <div class=\"card\"><div>Team count</div><div class=\"metric\">{len(team_counts)}</div></div>
        <div class=\"card\"><div>Scoped defects</div><div class=\"metric\">{scoped_defects}</div></div>
        <div class=\"card\"><div>Transition samples</div><div class=\"metric\">{sum(row[2] for row in transition_rows)}</div></div>
      </div>
    </section>

    <section>
      <h2>A. Team Coverage</h2>
      <table>
        <thead>
          <tr><th>Team</th><th>Scoped defects</th><th>Tickets in view</th><th>Tickets out of view</th><th>View rate</th></tr>
        </thead>
        <tbody>{team_lines}</tbody>
      </table>
    </section>

    <section>
      <h2>B. Transition Analysis</h2>
      <table>
        <thead>
          <tr><th>Transition</th><th>Group</th><th>Sample count</th><th>Average days</th></tr>
        </thead>
        <tbody>{transition_lines}</tbody>
      </table>
    </section>

    <section>
      <h2>C. Phase Efficiency Summary</h2>
      <table>
        <thead>
          <tr><th>Team</th><th>Group</th><th>Ticket count</th><th>Summed phase-average days</th></tr>
        </thead>
        <tbody>{efficiency_lines}</tbody>
      </table>
    </section>
  </main>
</body>
</html>"""


def generate_qgate_kpi_dashboard_report(
    *,
    db_path: str | Path | None = None,
    output_path: str | Path,
) -> Path:
    resolved_db_path = resolve_report_db_path(db_path)
    resolved_output_path = Path(output_path)
    require_tables(
        resolved_db_path,
        ("octane_defects", "octane_defect_history_events"),
    )

    conn = sqlite3.connect(str(resolved_db_path))
    try:
        defect_rows = conn.execute(
            "SELECT defect_id, team, raw_json FROM octane_defects ORDER BY defect_id"
        ).fetchall()
        history_rows = conn.execute(
            """
            SELECT defect_id, event_timestamp, old_value, new_value
            FROM octane_defect_history_events
            WHERE field_name = 'phase'
            ORDER BY defect_id, event_timestamp
            """
        ).fetchall()
    finally:
        conn.close()

    team_by_defect = {
        str(defect_id): _extract_team(team, raw_json)
        for defect_id, team, raw_json in defect_rows
    }
    team_counts: dict[str, int] = defaultdict(int)
    for team_name in team_by_defect.values():
        team_counts[team_name] += 1

    transition_totals: dict[tuple[str, str], list[float]] = defaultdict(list)
    efficiency_totals: dict[tuple[str, str], list[float]] = defaultdict(list)
    previous_timestamp_by_defect: dict[str, datetime | None] = {}
    transition_count = 0

    for defect_id, event_timestamp, old_value, new_value in history_rows:
        defect_key = str(defect_id)
        current_timestamp = _parse_timestamp(str(event_timestamp or ""))
        previous_timestamp = previous_timestamp_by_defect.get(defect_key)
        if previous_timestamp is None or current_timestamp is None:
            previous_timestamp_by_defect[defect_key] = current_timestamp
            continue

        elapsed_days = max(
            (current_timestamp - previous_timestamp).total_seconds() / 86400.0,
            0.0,
        )
        previous_timestamp_by_defect[defect_key] = current_timestamp

        transition_name = f"{old_value} -> {new_value}"
        transition_group = _extract_phase_group(new_value)
        transition_totals[(transition_name, transition_group)].append(elapsed_days)
        transition_count += 1

        team_name = team_by_defect.get(defect_key, "Unknown")
        efficiency_totals[(team_name, transition_group)].append(elapsed_days)

    if transition_count == 0:
        raise ValueError("No measurable phase transitions found in octane_defect_history_events")

    transition_rows = [
        (name, group, len(days), sum(days) / len(days) if days else 0.0)
        for (name, group), days in sorted(transition_totals.items())
    ]
    efficiency_rows = [
        (team, group, len(days), sum(days))
        for (team, group), days in sorted(efficiency_totals.items())
    ]

    html = _build_html(
        team_counts=dict(team_counts),
        transition_rows=transition_rows,
        efficiency_rows=efficiency_rows,
        scoped_defects=len(defect_rows),
    )
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(html, encoding="utf-8")
    return resolved_output_path