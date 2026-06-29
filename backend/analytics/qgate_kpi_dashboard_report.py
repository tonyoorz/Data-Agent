from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, time, timedelta
from pathlib import Path
import json
import re
import sqlite3
from typing import Any

from backend.analytics.qgate_kpi_report_common import (
    escape_html,
    require_tables,
    resolve_report_db_path,
)


PHASE_VALUE_MAP = {
    "phase.defect.new": "01-New",
    "phase.defect.opened": "02-In Pre-Analysis",
    "phase.defect.fixed": "06-Concluded",
    "phase.defect.deferred": "07-Deferred",
    "phase.defect.closed": "06-Concluded",
    "phase.defect.rejected": "06-Concluded",
}

DEFAULT_DASHBOARD_TEAMS = {
    "DTSV_China",
    "Spotlight_DTSV_China",
    "Spotlight_FIT",
    "[AT]BBA_Basis-FIT",
    "[AT]FIT_LAENDER_CHINA",
    "Plant-Dadong FIT",
    "Plant-Tiexi FIT",
    "[AT]W71-FIT",
    "[AT]W72-FIT",
}

CHINA_SPECIFIC_FIF = {
    "Connected Music China [01.04.01.06.04]",
    "DELETED_BMW Points (Mobile App) [01.04.03.02.01.01.01]",
    "Destination Input [01.04.03.01.03.02.05]",
    "Enable Authentication for ADAS L2 [01.04.01.08.02.11]",
    "eRoute [01.04.03.01.07]",
    "Festival Mode [01.04.02.01.02.01.04]",
    "Guiding 2.0 [01.04.02.01.03.03.07.07]",
    "Guiding 2.0 [01.04.02.02.01.04.02.11]",
    "Guiding 2.0 [01.04.02.03.03.03.05]",
    "Guiding 2.0 [01.04.02.05.01.03.07]",
    "Guiding 2.0 [01.04.03.01.03.06.03]",
    "Guiding ASIA [01.04.03.01.02.08]",
    "Guiding ECE+ROW [01.04.03.01.01.09]",
    "Guiding [01.04.03.01.03.02.03]",
    "Indoor Parking China [01.04.03.01.05.01]",
    "Itinerary (Mobile App) [01.04.03.01.01.07.09]",
    "Play audio via Online Services (Connected Music) [01.04.01.01.02]",
    "POI Functions ASIA [01.04.03.01.02.05]",
    "Positioning ASIA [01.04.03.01.02.01.02]",
    "Provide 3rd Party Gaming App [01.04.01.02.03.05]",
    "Provide 3rd party gaming enablement [01.04.01.02.03]",
    "Provide App Center China [01.04.01.06.09]",
    "Provide Child Seat App [01.04.01.06.12]",
    "Provide Co-Driver Entertainment [01.04.01.09.03]",
    "Provide Festival Mode [01.04.02.01.04.08]",
    "Provide Karaoke Service [01.04.01.06.10]",
    "Provide Navigation 2.0 [01.04.03.01.03.06]",
    "Provide NetEase Cloud Music [01.04.01.06.04.03]",
    "Provide Projected Modes China [01.04.01.06.13]",
    "Provide Projected Modes China navigation [01.04.01.06.13.09]",
    "Provide video casting china [01.04.01.06.14]",
    "QQ Music [01.04.01.06.04.02]",
    "QQ Music [01.04.01.06.06.02]",
    "Smart Access / Digital Key (Plus) [01.03.03.03.03]",
    "staging of Powernap [01.04.02.01.04.04.01]",
    "Tencent MiniProgramPlatform (Tencent MPP) [01.04.01.06.01]",
    "Tencent WeChat [01.04.01.06.02]",
    "Traffic Info ASIA [01.04.03.01.02.07]",
    "Traffic [01.04.03.01.03.02.04]",
    "Use App Store China [01.04.01.06.07]",
    "Use Co-Driver Entertainment [01.04.01.09.03]",
    "Use Rear Seat Entertainment [01.04.01.09.02]",
    "Use Speech operation [01.04.02.01.01.05]",
    "Video streaming China [01.04.01.06.05]",
    "Voice Interface [01.04.02.01.01.02]",
    "WeChat VoiP Call [01.04.01.06.02.02]",
    "Ximalaya [01.04.01.06.04.01]",
    "Ximalaya [01.04.01.06.06.03]",
}

CHINA_SPECIFIC_FIF_CODES = frozenset(
    match.group(1)
    for value in CHINA_SPECIFIC_FIF
    if (match := re.search(r"\[(\d+(?:\.\d+)*)\]", value))
)


def _parse_timestamp(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _hours_excluding_weekends(start: datetime | None, end: datetime | None) -> float:
    if start is None or end is None or end <= start:
        return 0.0

    if start.date() == end.date():
        return max((end - start).total_seconds(), 0.0) / 3600.0 if start.weekday() < 5 else 0.0

    start_next_midnight = datetime.combine(start.date() + timedelta(days=1), time.min, tzinfo=start.tzinfo)
    end_midnight = datetime.combine(end.date(), time.min, tzinfo=end.tzinfo)
    total_seconds = 0.0
    if start.weekday() < 5:
        total_seconds += max((start_next_midnight - start).total_seconds(), 0.0)

    full_days = max((end_midnight.date() - start_next_midnight.date()).days, 0)
    full_weeks, extra_days = divmod(full_days, 7)
    weekdays = full_weeks * 5
    first_full_day = start_next_midnight.date()
    weekdays += sum(1 for offset in range(extra_days) if (first_full_day + timedelta(days=offset)).weekday() < 5)
    total_seconds += weekdays * 86400.0

    if end.weekday() < 5:
        total_seconds += max((end - end_midnight).total_seconds(), 0.0)

    return total_seconds / 3600.0


def _parse_json(value: object) -> dict[str, Any]:
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


def _extract_team(team: object, raw_json: object) -> str:
    team_name = str(team or "").strip()
    if team_name:
        return team_name
    payload = _parse_json(raw_json)
    for key in ("problem_finder_team_udf", "problem_finder_team", "team"):
        resolved = _extract_named_value(payload.get(key))
        if resolved:
            return resolved
    return "Unknown"


def _extract_year(payload: dict[str, Any]) -> str:
    year_text = str(payload.get("year") or "").strip()
    if year_text:
        return year_text
    match = re.search(r"(20\d{2})", str(payload.get("creation_time") or ""))
    return match.group(1) if match else "Unknown"


def _parse_string_list(value: object) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item or "").strip() for item in value if str(item or "").strip()]
    try:
        parsed = json.loads(str(value))
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        return [str(item or "").strip() for item in parsed if str(item or "").strip()]
    text = str(value or "").strip()
    if not text:
        return []
    return [part.strip() for part in re.split(r"\s*\|\s*", text) if part.strip()]


def _extract_reference_names(value: object) -> list[str]:
    if not value:
        return []
    if isinstance(value, dict):
        raw_items = value.get("data")
        if isinstance(raw_items, list):
            return [_extract_named_value(item) for item in raw_items if _extract_named_value(item)]
        name = _extract_named_value(value)
        return [name] if name else []
    if isinstance(value, list):
        return [_extract_named_value(item) for item in value if _extract_named_value(item)]
    return []


def _extract_requirement_names(*, product_areas: object = "", requirement: object, requirements_json: object, payload: dict[str, Any]) -> list[str]:
    names: list[str] = []

    product_area_names = _parse_string_list(product_areas)
    if product_area_names:
        return _dedupe_names(product_area_names)

    names.extend(_extract_reference_names(payload.get("product_areas")))
    names.extend(_parse_string_list(requirements_json))
    names.extend(_parse_string_list(requirement))
    names.extend(_extract_reference_names(payload.get("requirements")))
    for key in ("problem_finder_feature_udf", "feature", "fif"):
        value = payload.get(key)
        names.extend(_extract_reference_names(value))
        if isinstance(value, str) and value.strip():
            names.append(value.strip())

    return _dedupe_names(names)


def _dedupe_names(names: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for name in names:
        if name and name not in seen:
            seen.add(name)
            deduped.append(name)
    return deduped


def _is_china_specific_requirement(requirement_name: str) -> bool:
    if requirement_name in CHINA_SPECIFIC_FIF:
        return True
    normalized_requirement_name = _normalize_fif_name(requirement_name)
    if normalized_requirement_name:
        for china_name in CHINA_SPECIFIC_FIF:
            normalized_china_name = _normalize_fif_name(china_name)
            if normalized_china_name and (
                normalized_china_name in normalized_requirement_name
                or normalized_requirement_name in normalized_china_name
            ):
                return True
    code_match = re.search(r"\[(\d+(?:\.\d+)*)\]", str(requirement_name or ""))
    if not code_match:
        return False
    code = code_match.group(1)
    return any(code == china_code or code.startswith(china_code + ".") for china_code in CHINA_SPECIFIC_FIF_CODES)


def _normalize_fif_name(value: object) -> str:
    text = re.sub(r"\s*\[\d+(?:\.\d+)*\]\s*", " ", str(value or ""))
    text = re.sub(r"[^a-z0-9]+", " ", text.casefold())
    return " ".join(text.split())


def _classify_fif(requirement_names: list[str]) -> str:
    if not requirement_names:
        return "(All)"
    return "China Specific" if any(_is_china_specific_requirement(name) for name in requirement_names) else "Global"


def _display_phase(value: object) -> str:
    text = str(value or "").strip()
    return PHASE_VALUE_MAP.get(text, text or "Unknown")


def _phase_prefix(phase_name: object) -> str | None:
    match = re.match(r"^(\d{2})", str(phase_name or "").strip())
    return match.group(1) if match else None


def _classify_transition_group(old_phase: object, new_phase: object) -> str:
    from_prefix = _phase_prefix(old_phase)
    to_prefix = _phase_prefix(new_phase)
    if from_prefix == "09" and to_prefix == "01":
        return "Integration"
    if from_prefix == "06" and to_prefix == "05":
        return "Integration"
    if not from_prefix:
        return "Other"
    if from_prefix in {"02", "07"}:
        return "Q-Gate"
    if from_prefix in {"00", "01", "08"}:
        return "Integration"
    if from_prefix in {"03", "04", "05"}:
        return "CoC"
    return "Other"


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _optional_text_expr(columns: set[str], column_name: str, fallback: str) -> str:
    return f"COALESCE(NULLIF({column_name}, ''), {fallback})" if column_name in columns else fallback


def _pct(part: int, total: int) -> float:
    return round(part / total * 100.0, 1) if total else 0.0


def _dataset(rows: list[dict[str, Any]], columns: list[str]) -> dict[str, Any]:
    return {"columns": columns, "rows": [[row.get(column) for column in columns] for row in rows]}


def _rows_to_table(rows: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    if not rows:
        return f"<tr><td colspan=\"{len(columns)}\">No data</td></tr>"
    return "".join(
        "<tr>" + "".join(f"<td>{escape_html(row.get(key))}</td>" for key, _label in columns) + "</tr>"
        for row in rows
    )


def _build_payload(*, defect_rows: list[sqlite3.Row], history_rows: list[sqlite3.Row]) -> dict[str, Any]:
    parsed_defects: list[dict[str, str]] = []
    for row in defect_rows:
        payload = _parse_json(row["raw_json"])
        defect_id = str(row["defect_id"] or "").strip()
        if not defect_id:
            continue
        requirement_names = _extract_requirement_names(
            product_areas=row["product_areas"] if "product_areas" in row.keys() else "",
            requirement=row["requirement"] if "requirement" in row.keys() else "",
            requirements_json=row["requirements_json"] if "requirements_json" in row.keys() else "",
            payload=payload,
        )
        parsed_defects.append(
            {
                "defect_id": defect_id,
                "team": _extract_team(row["team"], row["raw_json"]),
                "year": _extract_year(payload),
                "fif": _classify_fif(requirement_names),
                "fif_names": requirement_names,
                "name": str(row["name"] or payload.get("name") or "").strip(),
                "tester": _extract_named_value(payload.get("detected_by")),
            }
        )

    use_legacy_scope = any(record["team"] in DEFAULT_DASHBOARD_TEAMS for record in parsed_defects)
    scoped_defects = [record for record in parsed_defects if not use_legacy_scope or record["team"] in DEFAULT_DASHBOARD_TEAMS]
    defect_meta = {record["defect_id"]: record for record in scoped_defects}

    team_counts: Counter[str] = Counter(record["team"] for record in scoped_defects)
    team_year_counts: Counter[tuple[str, str]] = Counter((record["team"], record["year"]) for record in scoped_defects)

    previous_timestamp_by_defect: dict[str, datetime | None] = {}
    issues: list[dict[str, Any]] = []
    history_seen_defects: set[str] = set()
    history_ok_defects: set[str] = set()

    for row in history_rows:
        defect_id = str(row["defect_id"] or "").strip()
        if defect_id not in defect_meta:
            continue
        history_seen_defects.add(defect_id)
        current_timestamp = _parse_timestamp(row["event_timestamp"])
        previous_timestamp = previous_timestamp_by_defect.get(defect_id)
        previous_timestamp_by_defect[defect_id] = current_timestamp
        if previous_timestamp is None or current_timestamp is None:
            continue

        old_phase = _display_phase(row["old_phase"])
        new_phase = _display_phase(row["new_phase"])
        duration_hours = round(_hours_excluding_weekends(previous_timestamp, current_timestamp), 2)
        meta = defect_meta[defect_id]
        issues.append(
            {
                "Year": meta.get("year") or "Unknown",
                "Team": meta.get("team") or "Unknown",
                "Ticket_ID": defect_id,
                "Ticket_Name": meta.get("name") or "",
                "Tester": meta.get("tester") or "",
                "Ticket_URL": "",
                "Phase_Transition": f"{old_phase} -> {new_phase}",
                "Group": _classify_transition_group(old_phase, new_phase),
                "Duration_Hours": duration_hours,
                "Changed_By": str(row["changed_by"] or "Unknown").strip() or "Unknown",
                "FiF": meta.get("fif") or "(All)",
                "FiF_Names": json.dumps(meta.get("fif_names", []), ensure_ascii=False),
                "Ticket_Timespan_Days": None,
            }
        )
        history_ok_defects.add(defect_id)

    ticket_timespans = _compute_ticket_timespans(history_rows=history_rows, scoped_defect_ids=set(defect_meta))
    for issue in issues:
        issue["Ticket_Timespan_Days"] = ticket_timespans.get(str(issue["Ticket_ID"]))

    transition_values: dict[tuple[str, str], list[float]] = defaultdict(list)
    summary_values: dict[tuple[str, str], list[float]] = defaultdict(list)
    tickets_by_summary: dict[tuple[str, str], set[str]] = defaultdict(set)
    for issue in issues:
        duration_days = float(issue["Duration_Hours"] or 0.0) / 24.0
        transition_values[(issue["Phase_Transition"], issue["Group"])].append(duration_days)
        summary_values[(issue["Team"], issue["Group"])].append(duration_days)
        tickets_by_summary[(issue["Team"], issue["Group"])].add(str(issue["Ticket_ID"]))

    transition_rows = [
        {"transition": transition, "group": group, "sample_count": len(values), "avg_days": round(sum(values) / len(values), 2)}
        for (transition, group), values in sorted(transition_values.items(), key=lambda item: (-len(item[1]), item[0][1], item[0][0]))
    ]
    summary_rows = [
        {
            "team": team,
            "group": group,
            "ticket_count": len(tickets_by_summary[(team, group)]),
            "summed_avg_days": round(sum(values), 2),
        }
        for (team, group), values in sorted(summary_values.items())
    ]
    coverage_rows = []
    for (team, year), count in sorted(team_year_counts.items()):
        in_view_ids = {issue["Ticket_ID"] for issue in issues if issue["Team"] == team and issue["Year"] == year}
        coverage_rows.append(
            {"team": team, "year": year, "scoped_defects": count, "tickets_in_view": len(in_view_ids), "tickets_out_of_view": max(count - len(in_view_ids), 0)}
        )

    changed_by = sorted({issue["Changed_By"] for issue in issues if issue["Changed_By"]})
    total_defects = len(defect_meta)
    history_bad = max(total_defects - len(history_ok_defects), 0)
    meta_rows = [
        {
            "Team": team,
            "Defects": sum(count for (team_name, _year), count in team_year_counts.items() if team_name == team),
            "History_OK": len({issue["Ticket_ID"] for issue in issues if issue["Team"] == team}),
            "History_Missing_or_Error": max(sum(count for (team_name, _year), count in team_year_counts.items() if team_name == team) - len({issue["Ticket_ID"] for issue in issues if issue["Team"] == team}), 0),
        }
        for team in sorted(team_counts)
    ]
    coverage_dataset_rows = [
        {"Team": row["team"], "Year": row["year"], "Defects": row["scoped_defects"], "History_OK": row["tickets_in_view"], "History_Missing_or_Error": row["tickets_out_of_view"]}
        for row in coverage_rows
    ]
    ticket_rows = [
        {"Ticket_ID": defect_id, "Ticket_URL": "", "Ticket_Name": meta.get("name") or "", "Tester": meta.get("tester") or ""}
        for defect_id, meta in sorted(defect_meta.items())
    ]
    issue_columns = ["Year", "Team", "Ticket_ID", "Phase_Transition", "Group", "Duration_Hours", "Changed_By", "FiF", "FiF_Names", "Ticket_Timespan_Days"]
    issue_rows = [{column: issue.get(column) for column in issue_columns} for issue in issues]
    timespan_max = int(max([value for value in ticket_timespans.values() if value is not None] or [1]))

    return {
        "generated_from": {"defect_dir": "database/source/qgate_raw.db", "history_dir": "database/source/qgate_raw.db", "teams": sorted(team_counts), "min_transition_count": 200},
        "overview": {
            "team_count": len(team_counts),
            "total_defects": total_defects,
            "history_ok": len(history_ok_defects),
            "history_bad": history_bad,
            "history_success_rate": _pct(len(history_ok_defects), total_defects),
            "transition_samples": len(issues),
            "unique_transitions": len(transition_rows),
            "unique_tickets": len({issue["Ticket_ID"] for issue in issues}),
            "changed_by_count": len(changed_by),
            "timespan_max": timespan_max,
        },
        "options": {"teams": sorted(team_counts), "years": sorted({meta["year"] for meta in defect_meta.values()}), "groups": ["Q-Gate", "Integration", "CoC", "Other"], "changedBy": changed_by, "fif": ["China Specific", "Global"], "phaseTransitions": sorted({issue["Phase_Transition"] for issue in issues}), "timespanMax": timespan_max},
        "meta": _dataset(meta_rows, ["Team", "Defects", "History_OK", "History_Missing_or_Error"]),
        "coverage": _dataset(coverage_dataset_rows, ["Team", "Year", "Defects", "History_OK", "History_Missing_or_Error"]),
        "tickets": _dataset(ticket_rows, ["Ticket_ID", "Ticket_URL", "Ticket_Name", "Tester"]),
        "issues": _dataset(issue_rows, issue_columns),
        "transitions": transition_rows,
        "summary": summary_rows,
        "history_seen_defects": len(history_seen_defects),
    }


def _compute_ticket_timespans(*, history_rows: list[sqlite3.Row], scoped_defect_ids: set[str]) -> dict[str, float | None]:
    timespan_state: dict[str, dict[str, datetime | None]] = {defect_id: {"start": None, "end": None} for defect_id in scoped_defect_ids}
    previous_timestamp_by_defect: dict[str, datetime | None] = {}
    for row in history_rows:
        defect_id = str(row["defect_id"] or "").strip()
        if defect_id not in scoped_defect_ids:
            continue
        current_timestamp = _parse_timestamp(row["event_timestamp"])
        previous_timestamp = previous_timestamp_by_defect.get(defect_id)
        previous_timestamp_by_defect[defect_id] = current_timestamp
        if previous_timestamp is None or current_timestamp is None:
            continue
        old_prefix = _phase_prefix(_display_phase(row["old_phase"]))
        new_prefix = _phase_prefix(_display_phase(row["new_phase"]))
        state = timespan_state[defect_id]
        if old_prefix in {"00", "01"}:
            state["start"] = previous_timestamp if state["start"] is None or previous_timestamp < state["start"] else state["start"]
        if new_prefix in {"06", "09"}:
            state["end"] = current_timestamp if state["end"] is None or current_timestamp < state["end"] else state["end"]
    return {
        defect_id: round(_hours_excluding_weekends(state.get("start"), state.get("end")) / 24.0, 2) if state.get("start") and state.get("end") else None
        for defect_id, state in timespan_state.items()
    }


def _build_html(*, payload: dict[str, Any]) -> str:
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    transition_snapshot = _rows_to_table(
        payload["transitions"][:80],
        [("transition", "Transition"), ("group", "Group"), ("sample_count", "Sample count"), ("avg_days", "Average days")],
    )
    html = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QGate KPI Dashboard</title>
  <style>
    *{box-sizing:border-box}
    :root{--bg:#f3f5f8;--panel:#ffffff;--line:#e5e7eb;--ink:#1f2937;--muted:#6b7280;--brand:#0f2e5f;--qgate:#16a34a;--integration:#2563eb;--coc:#d97706;--other:#64748b}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink)}
    .wrap{max-width:1560px;margin:24px auto;padding:0 16px}.header{background:linear-gradient(140deg,#0f2e5f 0%,#163b77 55%,#2052a1 100%);color:#fff;border-radius:16px;padding:24px 28px;box-shadow:0 14px 30px rgba(15,46,95,.16)}
    h1{margin:0 0 8px 0;font-size:30px}h2{margin:0 0 10px 0;font-size:20px;color:var(--brand)}.sub{opacity:.92;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:16px}
    .card{background:rgba(255,255,255,.1);border-radius:12px;padding:14px;border:1px solid rgba(255,255,255,.16)}.k{font-size:13px;color:rgba(255,255,255,.82)}.v{font-size:28px;font-weight:700;margin-top:6px}.chg{font-size:12px;margin-top:6px;color:#dbeafe}
    .section{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 8px 20px rgba(15,23,42,.04)}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:start}.filter{display:flex;flex-direction:column;gap:6px}.filter label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.filter select,.filter input{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:var(--ink)}
    .filter-card{border:1px solid var(--line);border-radius:12px;background:#fcfcfd;padding:10px}.chip-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}.chip-actions{display:flex;gap:6px;flex-wrap:wrap}.chip-action{border:1px solid #cbd5e1;background:#fff;color:var(--muted);border-radius:999px;padding:4px 8px;font-size:11px;cursor:pointer}.chip-set{display:flex;flex-wrap:wrap;gap:8px;max-height:128px;overflow:auto}.chip{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:7px 10px;font-size:12px;line-height:1;cursor:pointer}.chip.active{background:#dbeafe;border-color:#60a5fa;color:#1d4ed8;font-weight:700}
    .split{display:grid;grid-template-columns:1.05fr .95fr;gap:14px}.chart-box{border:1px solid var(--line);border-radius:12px;padding:12px;background:#fcfcfd;margin-top:10px}.chart-title{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}.chart-title strong{font-size:14px;color:var(--brand)}.chart-title span,.tiny{font-size:12px;color:var(--muted)}
    .stack-wrap{display:grid;gap:10px}.stack-row{display:grid;grid-template-columns:170px 1fr 120px;gap:10px;align-items:center;font-size:12px}.stack-row .label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stack{height:18px;border-radius:999px;overflow:hidden;display:flex;background:#e5e7eb}.seg{height:100%;cursor:pointer;min-width:0}.qgate{background:var(--qgate)}.integration{background:var(--integration)}.coc{background:var(--coc)}.other{background:var(--other)}
    .legend{display:flex;gap:14px;font-size:12px;color:#475569;flex-wrap:wrap;margin:4px 0 10px}.dot{display:inline-block;width:10px;height:10px;border-radius:999px;margin-right:5px;vertical-align:middle}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:#eef2ff;font-weight:700}td.num,th.num{text-align:right}tbody tr:hover{background:#f8fafc}.scroll{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:12px}.bar-cell{display:grid;grid-template-columns:74px 1fr 76px;gap:8px;align-items:center}.bar-bg{height:14px;background:#e5e7eb;border-radius:999px;overflow:hidden}.bar-fill{height:100%;background:linear-gradient(90deg,#60a5fa,#2563eb)}.bar-fill.good{background:linear-gradient(90deg,#4ade80,#16a34a)}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;background:#eff6ff;color:#1d4ed8}.selection{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.empty{padding:16px;border:1px dashed #cbd5e1;border-radius:10px;color:var(--muted);text-align:center;background:#f8fafc}.clickable{cursor:pointer}.selected{background:#eff6ff}.footer{font-size:12px;color:var(--muted);margin:18px 0 6px}a{color:#1d4ed8;text-decoration:none}a:hover{text-decoration:underline}
    .fif-chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:8px 22px;padding:10px 4px 0;align-items:start}.fif-horizontal-row{display:grid;grid-template-columns:minmax(120px,210px) minmax(220px,1fr) 62px;gap:10px;align-items:center;min-height:28px}.fif-horizontal-label{font-weight:600;font-size:11px;color:#1f2937;line-height:1.15;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.fif-horizontal-track{height:16px;border-radius:999px;background:#e5e7eb;position:relative;overflow:visible}.fif-horizontal-bar{height:100%;min-width:2px;border-radius:999px;background:linear-gradient(90deg,#60a5fa,#2563eb);position:relative}.fif-horizontal-count{position:absolute;right:-8px;top:50%;transform:translate(100%,-50%);font-size:10px;font-weight:700;color:#0f2e5f;white-space:nowrap}.fif-horizontal-days{font-size:11px;color:#64748b;text-align:right;white-space:nowrap}.fif-y-axis{font-size:12px;color:#64748b;margin-bottom:6px}.fif-filter{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}.fif-filter label{font-size:11px;color:var(--muted)}.fif-filter input{width:48px;padding:4px 6px;font-size:11px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:var(--ink)}.fif-filter select{padding:4px 6px;font-size:11px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:var(--ink);max-width:260px}@media (max-width:760px){.fif-chart-grid{grid-template-columns:1fr}.fif-horizontal-row{grid-template-columns:1fr}.fif-horizontal-days{text-align:left}.fif-horizontal-count{right:4px;transform:translate(0,-50%);color:#fff}}
    @media (max-width:1100px){.split{grid-template-columns:1fr}.stack-row{grid-template-columns:1fr}.bar-cell{grid-template-columns:62px 1fr 70px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header"><h1>QGate KPI Dashboard</h1><div class="sub" id="generated-from">Native SQLite report</div><div class="grid" id="hero-cards"></div></div>
    <div class="section"><h2>Filters</h2><div class="filters"><div class="filter"><label>Year</label><div class="filter-card"><div class="chip-toolbar"><span class="tiny">Click to toggle</span><div class="chip-actions"><button type="button" class="chip-action" id="years-all-btn">All</button></div></div><div id="years-select"></div></div></div><div class="filter"><label>Teams</label><div class="filter-card"><div class="chip-toolbar"><span class="tiny">Click to toggle</span><div class="chip-actions"><button type="button" class="chip-action" id="teams-all-btn">All</button><button type="button" class="chip-action" id="teams-none-btn">None</button></div></div><div id="teams-select"></div></div></div><div class="filter"><label>Groups</label><div class="filter-card"><div class="chip-toolbar"><span class="tiny">Click to toggle</span><div class="chip-actions"><button type="button" class="chip-action" id="groups-all-btn">All</button></div></div><div id="groups-select"></div></div></div><div class="filter"><label>Changed By</label><select id="changed-by-select"></select></div><div class="filter"><label>FiF</label><select id="fif-select"></select></div><div class="filter"><label>Timespan Min (days)</label><input id="timespan-min" type="number" min="0" step="1" /></div><div class="filter"><label>Timespan Max (days)</label><input id="timespan-max" type="number" min="0" step="1" /></div><div class="filter"><label>Min Transition Count</label><input id="min-count-input" type="number" min="1" step="1" /></div><div class="filter"><label>&nbsp;</label><input id="reset-btn" type="button" value="Reset Filters" /></div></div><div class="selection" id="selection-summary"></div></div>
    <div class="section"><h2>A. Team Coverage</h2><div class="chart-box"><div class="chart-title"><strong>Coverage Bars</strong><span>In-view ticket coverage within scoped defects</span></div><div class="stack-wrap" id="coverage-bars"></div></div></div>
    <div class="section"><h2>B. Transition Analysis</h2><div class="chart-box"><div class="chart-title"><strong>Grouped Stacked View</strong><span>Average days by transition inside Q-Gate / Integration / CoC</span></div><div id="grouped-stacked"><table><tbody>__TRANSITION_SNAPSHOT__</tbody></table></div></div></div>
    <div class="section"><h2>C. Phase Efficiency Summary</h2><div class="legend"><span><span class="dot" style="background:var(--qgate)"></span>Q-Gate</span><span><span class="dot" style="background:var(--integration)"></span>Integration</span><span><span class="dot" style="background:var(--coc)"></span>CoC</span><span><span class="dot" style="background:var(--other)"></span>Other</span></div><div class="split"><div class="chart-box"><div class="chart-title"><strong>Team x Group Efficiency</strong><span>Click a segment to inspect team/group tickets below</span></div><div class="stack-wrap" id="summary-bars"></div></div><div class="chart-box"><div class="chart-title"><strong>Summary Table</strong><span>Ticket count and summed transition average days by team/group</span></div><div class="scroll"><table id="summary-table"></table></div></div></div><div class="chart-box"><div class="chart-title"><strong>Ticket Drilldown</strong><span id="team-group-title">Click a summary segment or row</span></div><div class="scroll"><table id="team-group-table"></table></div></div><div class="chart-box"><div class="chart-title"><strong>FiF Processing Time</strong><span id="fif-total-tickets">Total tickets: -</span><div class="fif-filter"><label>Phase</label><select id="fif-phase-select"></select><label>Min tickets</label><input id="fif-min-tickets" type="number" min="1" step="1" value="1" /></div></div><div class="fif-y-axis">Y-axis: average processing time (days)</div><div id="fif-duration-bars" class="fif-chart-grid"></div></div></div>
    <div class="footer" id="footer-text"></div>
  </div>
  <script>
    const QGATE_PAYLOAD = __PAYLOAD_JSON__;
    function decodeDataset(dataset){if(!dataset||!Array.isArray(dataset.columns)||!Array.isArray(dataset.rows))return Array.isArray(dataset)?dataset:[];return dataset.rows.map(row=>Object.fromEntries(dataset.columns.map((column,index)=>[column,row[index]])));}
    const META_ROWS=decodeDataset(QGATE_PAYLOAD.meta);const COVERAGE_ROWS=decodeDataset(QGATE_PAYLOAD.coverage);const TICKET_ROWS=decodeDataset(QGATE_PAYLOAD.tickets);const ISSUE_ROWS=decodeDataset(QGATE_PAYLOAD.issues);const TICKET_MAP=new Map(TICKET_ROWS.map(row=>[String(row.Ticket_ID||''),row]));
    const DEFAULT_YEARS=QGATE_PAYLOAD.options.years.includes('2025')?['2025']:[...QGATE_PAYLOAD.options.years];
    const state={years:[...DEFAULT_YEARS],teams:[...QGATE_PAYLOAD.options.teams],groups:[...QGATE_PAYLOAD.options.groups],changedBy:'all',fif:'all',timespanMin:0,timespanMax:Math.min(120,QGATE_PAYLOAD.options.timespanMax||120),minCount:QGATE_PAYLOAD.generated_from.min_transition_count||200,fifMinTickets:1,fifPhaseTransition:'all',selectedSummary:null};
    const groupClassMap={'Q-Gate':'qgate','Integration':'integration','CoC':'coc','Other':'other'};
    function fmtNumber(value,digits=0){const numeric=Number(value||0);return numeric.toLocaleString(undefined,{maximumFractionDigits:digits,minimumFractionDigits:digits});}
    function fmtMaybe(value,digits=2){if(value===null||value===undefined||Number.isNaN(Number(value)))return '-';return fmtNumber(Number(value),digits);}
    function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}function stripFiFCode(name){return String(name||'').replace(/\\s*\\[\\d+(?:\\.\\d+)*\\]\\s*/g,'').trim();}
    function renderTicketAnchor(ticketId,ticketUrl){if(!ticketId)return '-';if(!ticketUrl)return escapeHtml(ticketId);return `<a href="${escapeHtml(ticketUrl)}" target="_blank" rel="noreferrer">${escapeHtml(ticketId)}</a>`;}
    function renderChipSet(containerId,values,selectedValues){const container=document.getElementById(containerId);container.className='chip-set';container.innerHTML=values.map(value=>`<button type="button" class="chip single-line ${selectedValues.includes(value)?'active':''}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');}
    function filterIssues(){return ISSUE_ROWS.filter(row=>{if(state.years.length&&!state.years.includes(String(row.Year||'')))return false;if(state.teams.length&&!state.teams.includes(row.Team))return false;if(state.groups.length&&!state.groups.includes(row.Group))return false;if(state.changedBy!=='all'&&row.Changed_By!==state.changedBy)return false;if(state.fif!=='all'&&row.FiF!==state.fif)return false;const span=Number(row.Ticket_Timespan_Days);if(!Number.isNaN(span)&&(span<state.timespanMin||span>state.timespanMax))return false;if(Number.isNaN(span)&&(state.timespanMin>0||state.timespanMax<(QGATE_PAYLOAD.options.timespanMax||1)))return false;return true;});}
    function computeOverview(coverageRows,issues){const ticketIds=new Set(issues.map(row=>row.Ticket_ID).filter(Boolean));const transitions=new Set(issues.map(row=>row.Phase_Transition).filter(Boolean));const changedBy=new Set(issues.map(row=>row.Changed_By).filter(Boolean));const totalDefects=coverageRows.reduce((acc,row)=>acc+Number(row.Defects||0),0);const historyOk=coverageRows.reduce((acc,row)=>acc+Number(row.History_OK||0),0);const historyBad=coverageRows.reduce((acc,row)=>acc+Number(row.History_Missing_or_Error||0),0);return{teamCount:new Set(coverageRows.map(row=>row.Team).filter(Boolean)).size||state.teams.length,totalDefects,historyOk,historyBad,historySuccessRate:(historyOk+historyBad)>0?(historyOk/(historyOk+historyBad))*100:0,ticketCount:ticketIds.size,transitionCount:transitions.size,changedByCount:changedBy.size,transitionSamples:issues.length};}
    function buildTransitionSummary(issues){const bucket=new Map();issues.forEach(row=>{const key=[row.Phase_Transition,row.Group].join('||');if(!bucket.has(key))bucket.set(key,{Phase_Transition:row.Phase_Transition,Group:row.Group,Count:0,Hours_Total:0});const item=bucket.get(key);item.Count+=1;item.Hours_Total+=Number(row.Duration_Hours||0);});return Array.from(bucket.values()).filter(row=>Number(row.Count||0)>=Number(state.minCount||1)).map(row=>({Phase_Transition:row.Phase_Transition,Group:row.Group,Count:row.Count,Avg_Days:Number(((row.Hours_Total/Math.max(row.Count,1))/24).toFixed(3))})).sort((a,b)=>b.Avg_Days-a.Avg_Days||b.Count-a.Count);}
    function buildSummary(issues){const transitionBucket=new Map();issues.forEach(row=>{const key=[row.Team,row.Group,row.Phase_Transition].join('||');if(!transitionBucket.has(key))transitionBucket.set(key,{Team:row.Team,Group:row.Group,Phase_Transition:row.Phase_Transition,Hours_Total:0,Count:0});const item=transitionBucket.get(key);item.Hours_Total+=Number(row.Duration_Hours||0);item.Count+=1;});const bucket=new Map();Array.from(transitionBucket.values()).filter(row=>Number(row.Count||0)>=Number(state.minCount||1)).forEach(row=>{const key=[row.Team,row.Group].join('||');if(!bucket.has(key))bucket.set(key,{Team:row.Team,Group:row.Group,Ticket_IDs:new Set(),Transitions_Total:0,Phase_Days_Sum:0});const item=bucket.get(key);item.Transitions_Total+=1;item.Phase_Days_Sum+=(Number(row.Hours_Total||0)/Math.max(Number(row.Count||0),1))/24;});issues.forEach(row=>{const key=[row.Team,row.Group].join('||');if(!bucket.has(key))return;if(row.Ticket_ID)bucket.get(key).Ticket_IDs.add(row.Ticket_ID);});return Array.from(bucket.values()).map(row=>({Team:row.Team,Group:row.Group,Ticket_Count:row.Ticket_IDs.size,Transitions_Total:row.Transitions_Total,Phase_Days_Sum:Number(row.Phase_Days_Sum.toFixed(3))})).sort((a,b)=>a.Team.localeCompare(b.Team)||a.Group.localeCompare(b.Group));}
    function buildCoverageRows(filteredIssues){const selectedYears=new Set(state.years);const selectedTeams=new Set(state.teams);const aggregated=new Map();(COVERAGE_ROWS.length?COVERAGE_ROWS:META_ROWS).forEach(row=>{if(selectedYears.size&&!selectedYears.has(String(row.Year||'')))return;if(selectedTeams.size&&!selectedTeams.has(row.Team))return;const key=String(row.Team||'');if(!aggregated.has(key))aggregated.set(key,{Team:row.Team,Defects:0,History_OK:0,History_Missing_or_Error:0});const item=aggregated.get(key);item.Defects+=Number(row.Defects||0);item.History_OK+=Number(row.History_OK||0);item.History_Missing_or_Error+=Number(row.History_Missing_or_Error||0);});const ticketCounts=new Map();filteredIssues.forEach(row=>{const team=String(row.Team||'');const ticketId=String(row.Ticket_ID||'');if(!team||!ticketId)return;if(!ticketCounts.has(team))ticketCounts.set(team,new Set());ticketCounts.get(team).add(ticketId);});return Array.from(aggregated.values()).map(row=>{const total=Number(row.Defects||0);const inView=ticketCounts.get(String(row.Team||''))?.size||0;return{...row,Scoped_Defects:total,Tickets_In_View:inView,Tickets_Out_Of_View:Math.max(total-inView,0),View_Rate:total>0?Number(((inView/total)*100).toFixed(1)):0};}).sort((a,b)=>Number(b.Tickets_In_View||0)-Number(a.Tickets_In_View||0)||Number(b.Defects||0)-Number(a.Defects||0));}
    function buildFifDurationRows(issues){const phaseFiltered=state.fifPhaseTransition==='all'?issues:issues.filter(row=>row.Phase_Transition===state.fifPhaseTransition);const phaseBucket=new Map();phaseFiltered.forEach(row=>{const ticketId=String(row.Ticket_ID||'');if(!ticketId)return;const fifNames=JSON.parse(row.FiF_Names||'[]');const names=fifNames.length?fifNames:[row.FiF||'(All)'];names.forEach(name=>{const key=[name,ticketId,row.Phase_Transition].join('||');if(!phaseBucket.has(key))phaseBucket.set(key,{FiF:name,Ticket_ID:ticketId,Phase_Transition:row.Phase_Transition,Hours_Total:0,Count:0});const item=phaseBucket.get(key);item.Hours_Total+=Number(row.Duration_Hours||0);item.Count+=1;});});const bucket=new Map();Array.from(phaseBucket.values()).forEach(row=>{if(!bucket.has(row.FiF))bucket.set(row.FiF,new Map());const ticketMap=bucket.get(row.FiF);if(!ticketMap.has(row.Ticket_ID))ticketMap.set(row.Ticket_ID,[]);ticketMap.get(row.Ticket_ID).push((row.Hours_Total/Math.max(row.Count,1))/24);});return Array.from(bucket.entries()).map(([name,tickets])=>{const durations=Array.from(tickets.values()).map(values=>values.reduce((acc,value)=>acc+value,0)/Math.max(values.length,1));const avgDays=durations.length?durations.reduce((acc,value)=>acc+value,0)/durations.length:0;return{FiF:name,Ticket_Count:tickets.size,Avg_Days:Number(avgDays.toFixed(2))};}).filter(row=>row.Ticket_Count>0).sort((a,b)=>b.Avg_Days-a.Avg_Days||b.Ticket_Count-a.Ticket_Count);}
    function renderHero(overview){const cards=[{label:'Teams',value:fmtNumber(overview.teamCount),meta:`${state.years.join(', ')||'all years'} selected`},{label:'Scoped Defects',value:fmtNumber(overview.totalDefects),meta:`Across ${fmtNumber(overview.teamCount)} teams`},{label:'Tickets in View',value:fmtNumber(overview.ticketCount),meta:`${fmtNumber(overview.changedByCount)} changers represented`},{label:'Transition Samples',value:fmtNumber(overview.transitionSamples),meta:`${fmtNumber(overview.transitionCount)} transitions`}];document.getElementById('hero-cards').innerHTML=cards.map(card=>`<div class="card"><div class="k">${escapeHtml(card.label)}</div><div class="v">${escapeHtml(card.value)}</div><div class="chg">${escapeHtml(card.meta)}</div></div>`).join('');}
    function renderSelections(){const pills=[`Years: ${state.years.length?state.years.join(', '):'none'}`,`Teams: ${state.teams.length?state.teams.join(', '):'none'}`,`Groups: ${state.groups.length?state.groups.join(', '):'none'}`,`Changed By: ${state.changedBy}`,`FiF: ${state.fif}`,`Timespan: ${state.timespanMin}-${state.timespanMax} days`,`Min Count: ${state.minCount}`,`FiF Min Tickets: ${state.fifMinTickets}`];document.getElementById('selection-summary').innerHTML=pills.map(text=>`<span class="pill">${escapeHtml(text)}</span>`).join('');}
    function renderCoverage(coverageRows){const maxInView=Math.max(1,...coverageRows.map(row=>Number(row.Tickets_In_View||0)));document.getElementById('coverage-bars').innerHTML=coverageRows.map(row=>{const width=Number(row.Tickets_In_View||0)/maxInView*100;return `<div class="stack-row"><div class="label">${escapeHtml(row.Team)}</div><div class="bar-cell"><div class="tiny">${fmtMaybe(row.View_Rate,1)}%</div><div class="bar-bg"><div class="bar-fill good" style="width:${Math.max(width,2)}%"></div></div><div class="tiny">${fmtNumber(row.Tickets_In_View)}</div></div><div class="tiny">In View ${fmtNumber(row.Tickets_In_View)} / Scoped ${fmtNumber(row.Scoped_Defects)} / Out ${fmtNumber(row.Tickets_Out_Of_View)}</div></div>`;}).join('')||'<div class="empty">No coverage bars available.</div>';}
    function renderGroupedViews(transitionRows){const groups=['Q-Gate','Integration','CoC'];const globalMaxValue=Math.max(1,...transitionRows.map(row=>Number(row.Avg_Days||0)));document.getElementById('grouped-stacked').innerHTML=groups.map(group=>{const rows=transitionRows.filter(row=>row.Group===group).sort((a,b)=>b.Avg_Days-a.Avg_Days||b.Count-a.Count);return `<div style="margin-bottom:14px"><div class="chart-title"><strong>${escapeHtml(group)}</strong><span>${fmtNumber(rows.length)} transitions</span></div>${rows.slice(0,20).map(row=>`<div class="stack-row"><div class="label">${escapeHtml(row.Phase_Transition)}</div><div class="bar-cell"><div class="tiny">${fmtMaybe(row.Avg_Days,2)} d</div><div class="bar-bg"><div class="bar-fill" style="width:${Math.max((Number(row.Avg_Days||0)/globalMaxValue)*100,Number(row.Avg_Days||0)>0?2:0)}%"></div></div><div class="tiny">${fmtNumber(row.Count)} samples</div></div></div>`).join('')||'<div class="empty">No transitions in this group.</div>'}</div>`;}).join('');}
    function renderSummary(summaryRows){const byTeam=new Map();summaryRows.forEach(row=>{if(!byTeam.has(row.Team))byTeam.set(row.Team,[]);byTeam.get(row.Team).push(row);});const orderedTeams=Array.from(byTeam.entries()).map(([team,rows])=>({team,rows,total:rows.reduce((acc,row)=>acc+Number(row.Phase_Days_Sum||0),0)})).sort((a,b)=>b.total-a.total);const maxTotal=Math.max(1,...orderedTeams.map(item=>item.total));const bars=document.getElementById('summary-bars');bars.innerHTML=orderedTeams.map(item=>{const totalWidth=item.total/maxTotal*100;const segmentHtml=item.rows.sort((a,b)=>Number(b.Phase_Days_Sum||0)-Number(a.Phase_Days_Sum||0)).map(row=>{const segWidth=item.total>0?(Number(row.Phase_Days_Sum||0)/item.total)*totalWidth:0;return `<div class="seg ${groupClassMap[row.Group]||'other'}" style="width:${Math.max(segWidth,Number(row.Phase_Days_Sum||0)>0?2:0)}%" data-team="${escapeHtml(row.Team)}" data-group="${escapeHtml(row.Group)}" title="${escapeHtml(row.Group)} | Summed Phase Avg ${fmtMaybe(row.Phase_Days_Sum,2)} d | Tickets ${fmtNumber(row.Ticket_Count)}"></div>`;}).join('');return `<div class="stack-row"><div class="label">${escapeHtml(item.team)}</div><div class="stack">${segmentHtml}</div><div class="tiny">${fmtMaybe(item.total,2)} d summed phase avg</div></div>`;}).join('')||'<div class="empty">No summary rows for the current filter.</div>';bars.querySelectorAll('.seg').forEach(node=>node.addEventListener('click',()=>{state.selectedSummary={team:node.dataset.team,group:node.dataset.group};render();}));document.getElementById('summary-table').innerHTML=`<thead><tr><th>Team</th><th>Group</th><th class="num">Ticket Count</th><th class="num">Summed Phase Avg Days</th></tr></thead><tbody>${summaryRows.map(row=>{const selected=state.selectedSummary&&state.selectedSummary.team===row.Team&&state.selectedSummary.group===row.Group;return `<tr class="clickable ${selected?'selected':''}" data-team="${escapeHtml(row.Team)}" data-group="${escapeHtml(row.Group)}"><td>${escapeHtml(row.Team)}</td><td>${escapeHtml(row.Group)}</td><td class="num">${fmtNumber(row.Ticket_Count)}</td><td class="num">${fmtMaybe(row.Phase_Days_Sum,2)}</td></tr>`;}).join('')||'<tr><td colspan="4" class="empty">No summary rows available.</td></tr>'}</tbody>`;document.querySelectorAll('#summary-table tbody tr.clickable').forEach(node=>node.addEventListener('click',()=>{state.selectedSummary={team:node.dataset.team,group:node.dataset.group};render();}));}
    function renderFifDurationChart(rows){const filtered=rows.filter(row=>Number(row.Ticket_Count||0)>=state.fifMinTickets);if(!filtered.length){document.getElementById('fif-duration-bars').innerHTML='<div class="empty">No FiF groups meet the minimum ticket threshold.</div>';return;}const maxDays=Math.max(1,...filtered.map(row=>Number(row.Avg_Days||0)));document.getElementById('fif-duration-bars').innerHTML=filtered.map(row=>{const width=Math.max(1,Number(row.Avg_Days||0)/maxDays*100);const displayName=stripFiFCode(row.FiF);return `<div class="fif-horizontal-row"><div class="fif-horizontal-label" title="${escapeHtml(row.FiF)}">${escapeHtml(displayName)}</div><div class="fif-horizontal-track"><div class="fif-horizontal-bar" style="width:${width}%" title="${escapeHtml(row.FiF)} | ${fmtMaybe(row.Avg_Days,2)} d | ${fmtNumber(row.Ticket_Count)} tickets"><span class="fif-horizontal-count">${fmtNumber(row.Ticket_Count)}</span></div></div><div class="fif-horizontal-days">${fmtMaybe(row.Avg_Days,2)}d</div></div>`;}).join('');}
    function renderDrilldown(filteredIssues,summaryRows){let selection=state.selectedSummary;if(selection&&!summaryRows.some(row=>row.Team===selection.team&&row.Group===selection.group)){selection=null;state.selectedSummary=null;}if(!selection&&summaryRows.length){selection={team:summaryRows[0].Team,group:summaryRows[0].Group};state.selectedSummary=selection;}const table=document.getElementById('team-group-table');if(!selection){document.getElementById('team-group-title').textContent='No team/group selection available';table.innerHTML='<tr><td class="empty">No team/group drilldown rows.</td></tr>';return;}const rows=filteredIssues.filter(row=>row.Team===selection.team&&row.Group===selection.group);const grouped=new Map();rows.forEach(row=>{const ticketMeta=TICKET_MAP.get(String(row.Ticket_ID||''))||{};const key=[row.Ticket_ID,row.Team,row.Group,row.FiF].join('||');if(!grouped.has(key))grouped.set(key,{Ticket_ID:row.Ticket_ID,Ticket_URL:ticketMeta.Ticket_URL||'',Ticket_Name:ticketMeta.Ticket_Name||'',Tester:ticketMeta.Tester||'',Team:row.Team,Group:row.Group,FiF:row.FiF,Duration_Hours:0,Duration_Days:0,Transitions:new Set()});const item=grouped.get(key);item.Duration_Hours+=Number(row.Duration_Hours||0);item.Duration_Days+=Number(row.Duration_Hours||0)/24;item.Transitions.add(row.Phase_Transition);});const ticketRows=Array.from(grouped.values()).map(row=>({...row,Transitions:row.Transitions.size})).sort((a,b)=>b.Duration_Days-a.Duration_Days||b.Transitions-a.Transitions);document.getElementById('team-group-title').textContent=`${selection.team} / ${selection.group} (${fmtNumber(ticketRows.length)} tickets)`;table.innerHTML=`<thead><tr><th>Ticket</th><th>Name</th><th>Tester</th><th>FiF</th><th class="num">Transitions</th><th class="num">Duration Days</th><th class="num">Duration Hours</th></tr></thead><tbody>${ticketRows.map(row=>`<tr><td>${renderTicketAnchor(row.Ticket_ID,row.Ticket_URL)}</td><td>${escapeHtml(row.Ticket_Name)}</td><td>${escapeHtml(row.Tester)}</td><td>${escapeHtml(row.FiF)}</td><td class="num">${fmtNumber(row.Transitions)}</td><td class="num">${fmtMaybe(row.Duration_Days,2)}</td><td class="num">${fmtMaybe(row.Duration_Hours,2)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No ticket rows for the current team/group.</td></tr>'}</tbody>`;}
    state.selectedFifName=null;const DRILLDOWN_LIMIT=200;let renderTimer=null;
    function issueFifNames(row){try{const names=JSON.parse(row.FiF_Names||'[]');return Array.isArray(names)&&names.length?names:[row.FiF||'(All)'];}catch{return[row.FiF||'(All)'];}}
    function renderFifDurationChart(rows){const filtered=rows.filter(row=>Number(row.Ticket_Count||0)>=state.fifMinTickets);const container=document.getElementById('fif-duration-bars');if(!filtered.length){container.innerHTML='<div class="empty">No FiF groups meet the minimum ticket threshold.</div>';return;}const maxDays=Math.max(1,...filtered.map(row=>Number(row.Avg_Days||0)));container.innerHTML=filtered.map(row=>{const width=Math.max(1,Number(row.Avg_Days||0)/maxDays*100);const displayName=stripFiFCode(row.FiF);const selected=state.selectedFifName===row.FiF;return `<div class="fif-horizontal-row clickable ${selected?'selected':''}" data-fif-name="${escapeHtml(row.FiF)}"><div class="fif-horizontal-label" title="${escapeHtml(row.FiF)}">${escapeHtml(displayName)}</div><div class="fif-horizontal-track"><div class="fif-horizontal-bar" style="width:${width}%" title="${escapeHtml(row.FiF)} | ${fmtMaybe(row.Avg_Days,2)} d | ${fmtNumber(row.Ticket_Count)} tickets"><span class="fif-horizontal-count">${fmtNumber(row.Ticket_Count)}</span></div></div><div class="fif-horizontal-days">${fmtMaybe(row.Avg_Days,2)}d</div></div>`;}).join('');container.querySelectorAll('.fif-horizontal-row.clickable').forEach(node=>node.addEventListener('click',()=>{const name=node.dataset.fifName||'';state.selectedFifName=state.selectedFifName===name?null:name;render();}));}
    function renderDrilldown(filteredIssues){const selectedName=state.selectedFifName;const grouped=new Map();filteredIssues.forEach(row=>{const names=issueFifNames(row).filter(name=>!selectedName||name===selectedName);names.forEach(name=>{const key=[row.Ticket_ID,name,row.Phase_Transition].join('||');if(!grouped.has(key)){const ticketMeta=TICKET_MAP.get(String(row.Ticket_ID||''))||{};grouped.set(key,{Ticket_ID:row.Ticket_ID,Ticket_URL:ticketMeta.Ticket_URL||'',Ticket_Name:ticketMeta.Ticket_Name||'',Team:row.Team,FiF:name,Phase_Transition:row.Phase_Transition,Phase_Hours:0,Count:0});}const item=grouped.get(key);item.Phase_Hours+=Number(row.Duration_Hours||0);item.Count+=1;});});const rows=Array.from(grouped.values()).map(row=>({...row,Duration_Days:(row.Phase_Hours/Math.max(row.Count,1))/24})).sort((a,b)=>String(a.Ticket_ID||'').localeCompare(String(b.Ticket_ID||''))||String(a.Phase_Transition||'').localeCompare(String(b.Phase_Transition||'')));const visibleRows=rows.slice(0,DRILLDOWN_LIMIT);const ticketCount=new Set(rows.map(row=>row.Ticket_ID).filter(Boolean)).size;const titlePrefix=selectedName?`FiF: ${stripFiFCode(selectedName)}`:'Filtered tickets';document.getElementById('team-group-title').textContent=`${titlePrefix} (${fmtNumber(ticketCount)} tickets, showing ${fmtNumber(visibleRows.length)} / ${fmtNumber(rows.length)} phase rows)`;const table=document.getElementById('team-group-table');table.innerHTML=`<thead><tr><th>Ticket ID</th><th>Name</th><th>Defect Finder Team</th><th>FiF</th><th>Phase</th><th class="num">Days</th></tr></thead><tbody>${visibleRows.map(row=>`<tr><td>${renderTicketAnchor(row.Ticket_ID,row.Ticket_URL)}</td><td>${escapeHtml(row.Ticket_Name)}</td><td>${escapeHtml(row.Team)}</td><td>${escapeHtml(row.FiF)}</td><td>${escapeHtml(row.Phase_Transition)}</td><td class="num">${fmtMaybe(row.Duration_Days,2)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">No ticket rows for the current filters.</td></tr>'}</tbody>`;}
    function scheduleRender(){if(renderTimer!==null)clearTimeout(renderTimer);renderTimer=setTimeout(()=>{renderTimer=null;renderNow();},50);}function render(){scheduleRender();}
    function renderNow(){renderSelections();const filteredIssues=filterIssues();const drilldownIssues=state.fifPhaseTransition==='all'?filteredIssues:filteredIssues.filter(row=>row.Phase_Transition===state.fifPhaseTransition);document.getElementById('fif-total-tickets').textContent=`Total tickets: ${fmtNumber(new Set(drilldownIssues.map(row=>row.Ticket_ID).filter(Boolean)).size)}`;const summary=buildSummary(filteredIssues);const transition=buildTransitionSummary(filteredIssues);const coverageRows=buildCoverageRows(filteredIssues);const overview=computeOverview(coverageRows,filteredIssues);renderHero(overview);renderCoverage(coverageRows);renderSummary(summary);renderGroupedViews(transition);renderFifDurationChart(buildFifDurationRows(filteredIssues));renderDrilldown(drilldownIssues,summary);document.getElementById('footer-text').textContent='Standalone export generated from Vizion Lab SQLite source database.';}
    function populateFilters(){renderChipSet('years-select',QGATE_PAYLOAD.options.years,state.years);renderChipSet('teams-select',QGATE_PAYLOAD.options.teams,state.teams);renderChipSet('groups-select',QGATE_PAYLOAD.options.groups,state.groups);const changedBySelect=document.getElementById('changed-by-select');const fifSelect=document.getElementById('fif-select');changedBySelect.innerHTML=['all',...QGATE_PAYLOAD.options.changedBy].map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');fifSelect.innerHTML=['all',...QGATE_PAYLOAD.options.fif].map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');changedBySelect.value=state.changedBy;fifSelect.value=state.fif;document.getElementById('timespan-min').value=String(state.timespanMin);document.getElementById('timespan-max').value=String(state.timespanMax);document.getElementById('min-count-input').value=String(state.minCount);document.getElementById('fif-min-tickets').value=String(state.fifMinTickets);const fifPhaseSelect=document.getElementById('fif-phase-select');fifPhaseSelect.innerHTML=['all',...QGATE_PAYLOAD.options.phaseTransitions].map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');fifPhaseSelect.value=state.fifPhaseTransition;document.querySelectorAll('#years-select .chip').forEach(node=>node.onclick=()=>{const value=node.dataset.value;state.years=state.years.includes(value)?state.years.filter(item=>item!==value):[...state.years,value];state.selectedSummary=null;populateFilters();render();});document.querySelectorAll('#teams-select .chip').forEach(node=>node.onclick=()=>{const value=node.dataset.value;state.teams=state.teams.includes(value)?state.teams.filter(item=>item!==value):[...state.teams,value];state.selectedSummary=null;populateFilters();render();});document.querySelectorAll('#groups-select .chip').forEach(node=>node.onclick=()=>{const value=node.dataset.value;state.groups=state.groups.includes(value)?state.groups.filter(item=>item!==value):[...state.groups,value];state.selectedSummary=null;populateFilters();render();});document.getElementById('years-all-btn').onclick=()=>{state.years=[...QGATE_PAYLOAD.options.years];state.selectedSummary=null;populateFilters();render();};document.getElementById('teams-all-btn').onclick=()=>{state.teams=[...QGATE_PAYLOAD.options.teams];state.selectedSummary=null;populateFilters();render();};document.getElementById('teams-none-btn').onclick=()=>{state.teams=[];state.selectedSummary=null;populateFilters();render();};document.getElementById('groups-all-btn').onclick=()=>{state.groups=[...QGATE_PAYLOAD.options.groups];state.selectedSummary=null;populateFilters();render();};changedBySelect.onchange=()=>{state.changedBy=changedBySelect.value;state.selectedSummary=null;render();};fifSelect.onchange=()=>{state.fif=fifSelect.value;state.selectedSummary=null;render();};document.getElementById('timespan-min').onchange=event=>{state.timespanMin=Math.max(0,Number(event.target.value||0));render();};document.getElementById('timespan-max').onchange=event=>{state.timespanMax=Math.max(0,Number(event.target.value||QGATE_PAYLOAD.options.timespanMax||1));render();};document.getElementById('min-count-input').onchange=event=>{state.minCount=Math.max(1,Number(event.target.value||1));state.selectedSummary=null;render();};document.getElementById('fif-min-tickets').onchange=event=>{state.fifMinTickets=Math.max(1,Number(event.target.value||1));render();};fifPhaseSelect.onchange=()=>{state.fifPhaseTransition=fifPhaseSelect.value;render();};document.getElementById('reset-btn').onclick=()=>{state.years=[...DEFAULT_YEARS];state.teams=[...QGATE_PAYLOAD.options.teams];state.groups=[...QGATE_PAYLOAD.options.groups];state.changedBy='all';state.fif='all';state.timespanMin=0;state.timespanMax=Math.min(120,QGATE_PAYLOAD.options.timespanMax||120);state.minCount=QGATE_PAYLOAD.generated_from.min_transition_count||200;state.fifMinTickets=1;state.fifPhaseTransition='all';state.selectedSummary=null;populateFilters();render();};}
    document.getElementById('generated-from').textContent=`source=${QGATE_PAYLOAD.generated_from.defect_dir} | teams=${QGATE_PAYLOAD.generated_from.teams.join(', ')}`;
    populateFilters();render();
  </script>
</body>
</html>"""
    return html.replace("__PAYLOAD_JSON__", payload_json).replace("__TRANSITION_SNAPSHOT__", transition_snapshot)


def generate_qgate_kpi_dashboard_report(*, db_path: str | Path | None = None, output_path: str | Path) -> Path:
    resolved_db_path = resolve_report_db_path(db_path)
    resolved_output_path = Path(output_path)
    require_tables(resolved_db_path, ("octane_defects", "octane_defect_history_events"))

    conn = sqlite3.connect(str(resolved_db_path))
    conn.row_factory = sqlite3.Row
    try:
        defect_columns = _table_columns(conn, "octane_defects")
        history_columns = _table_columns(conn, "octane_defect_history_events")
        requirement_expr = "requirement" if "requirement" in defect_columns else "''"
        requirements_json_expr = "requirements_json" if "requirements_json" in defect_columns else "'[]'"
        product_areas_expr = "product_areas" if "product_areas" in defect_columns else "''"
        old_phase_expr = _optional_text_expr(history_columns, "old_value_text", "old_value")
        new_phase_expr = _optional_text_expr(history_columns, "new_value_text", "new_value")
        changed_by_expr = "user_name" if "user_name" in history_columns else "'Unknown'"
        defect_rows = conn.execute(
            f"SELECT defect_id, name, team, raw_json, {product_areas_expr} AS product_areas, {requirement_expr} AS requirement, {requirements_json_expr} AS requirements_json FROM octane_defects ORDER BY defect_id"
        ).fetchall()
        history_rows = conn.execute(
            f"""
            SELECT defect_id, event_timestamp,
                   {old_phase_expr} AS old_phase,
                   {new_phase_expr} AS new_phase,
                   {changed_by_expr} AS changed_by
            FROM octane_defect_history_events
            WHERE field_name = 'phase'
            ORDER BY defect_id, event_timestamp
            """
        ).fetchall()
    finally:
        conn.close()

    payload = _build_payload(defect_rows=defect_rows, history_rows=history_rows)
    if not payload["issues"]["rows"]:
        raise ValueError("No measurable phase transitions found in octane_defect_history_events")

    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(_build_html(payload=payload), encoding="utf-8")
    return resolved_output_path