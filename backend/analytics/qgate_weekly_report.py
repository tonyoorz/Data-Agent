from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sqlite3
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.db import connect


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    if not _table_exists(conn, table_name):
        return set()
    return {str(row["name"]).strip() for row in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()}


def _optional_expr(columns: set[str], column_name: str) -> str:
    if column_name not in columns:
        return "''"
    return f"COALESCE(CAST({column_name} AS TEXT), '')"


def _year_where(columns: set[str], year: str) -> tuple[str, list[str]]:
    if not year or "year" not in columns:
        return "1=1", []
    return "TRIM(COALESCE(CAST(year AS TEXT), '')) = ?", [year]


def _parse_week_key(test_week: Any) -> tuple[int, int] | None:
    text = str(test_week or "").strip()
    if not text or "future" in text.casefold():
        return None
    match = __import__("re").search(r"(\d{2,4})\s*-\s*CW\s*(\d{1,2})", text, flags=__import__("re").IGNORECASE)
    if not match:
        return None
    year = int(match.group(1))
    if year < 100:
        year += 2000
    week = int(match.group(2))
    return year, week


def _week_sort_key(test_week: Any) -> tuple[int, int, str]:
    key = _parse_week_key(test_week)
    if key is None:
        return 9999, 99, str(test_week or "")
    return key[0], key[1], str(test_week or "")


def _is_pmg(team: str) -> bool:
    normalized = team.casefold()
    return "pmg" in normalized or "plant" in normalized or "bba" in normalized


def _is_shk(team: str) -> bool:
    normalized = team.casefold()
    return "shk" in normalized or "dtsv" in normalized or "[at]" in normalized or "fit" in normalized


def _phase_code(value: Any) -> str:
    text = str(value or "").strip()
    return text[:2] if len(text) >= 2 and text[:2].isdigit() else ""


def _status_bucket(status: str) -> str:
    normalized = status.casefold()
    if "pass" in normalized:
        return "passed"
    if "fail" in normalized:
        return "failed"
    if "attention" in normalized:
        return "requires_attention"
    if "planned" in normalized:
        return "planned"
    return "other"


def _parse_iso_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_hours(started: Any, finished: Any) -> float:
    start = _parse_iso_datetime(started)
    end = _parse_iso_datetime(finished)
    if start is None or end is None or end <= start:
        return 0.0
    return round((end - start).total_seconds() / 3600.0, 2)


def _resolve_db_path(db_path: str | Path | None) -> Path:
    return Path(db_path).resolve() if db_path is not None else get_full_picture_source_db_path()


def _build_defect_sections(conn: sqlite3.Connection, year: str) -> dict[str, Any]:
    columns = _table_columns(conn, "octane_defects")
    if not columns:
        return {
            "defect_quality_rows": [],
            "defect_owner_rows": [],
            "rejected_reason_rows": [],
            "defect_total": 0,
            "in_verification_total": 0,
            "rejected_total": 0,
        }

    where_clause, params = _year_where(columns, year)
    rows = conn.execute(
        f"""
        SELECT
            TRIM({_optional_expr(columns, 'project')}) AS project,
            TRIM({_optional_expr(columns, 'lead_model')}) AS lead_model,
            TRIM({_optional_expr(columns, 'problem_finder_team')}) AS problem_finder_team,
            TRIM({_optional_expr(columns, 'owner')}) AS owner,
            TRIM({_optional_expr(columns, 'phase')}) AS phase,
            TRIM({_optional_expr(columns, 'status_phase')}) AS status_phase,
            TRIM(COALESCE({_optional_expr(columns, 'reporting_class')}, {_optional_expr(columns, 'problem_severity')}, '')) AS reason
        FROM octane_defects
        WHERE {where_clause}
        """,
        params,
    ).fetchall()

    quality: dict[tuple[str, str], dict[str, Any]] = {}
    owners: dict[str, dict[str, Any]] = {}
    rejected_reasons: dict[str, int] = {}
    in_verification_total = 0
    rejected_total = 0

    for row in rows:
        project = str(row["project"] or "Unknown") or "Unknown"
        lead_model = str(row["lead_model"] or "Unknown") or "Unknown"
        team = str(row["problem_finder_team"] or "")
        phase_code = _phase_code(row["phase"]) or _phase_code(row["status_phase"])
        key = (project, lead_model)
        current_quality = quality.setdefault(
            key,
            {"project": project, "lead_model": lead_model, "pmg": 0, "shk": 0, "total": 0},
        )
        current_quality["total"] += 1
        if _is_pmg(team):
            current_quality["pmg"] += 1
        if _is_shk(team):
            current_quality["shk"] += 1

        if phase_code in {"08", "09"}:
            owner = str(row["owner"] or "Unassigned") or "Unassigned"
            current_owner = owners.setdefault(
                owner,
                {"owner": owner, "in_verification": 0, "rejected": 0, "total": 0},
            )
            if phase_code == "08":
                current_owner["in_verification"] += 1
                in_verification_total += 1
            if phase_code == "09":
                current_owner["rejected"] += 1
                rejected_total += 1
                reason = str(row["reason"] or "Unknown") or "Unknown"
                rejected_reasons[reason] = rejected_reasons.get(reason, 0) + 1
            current_owner["total"] += 1

    return {
        "defect_quality_rows": sorted(quality.values(), key=lambda row: (-row["total"], row["project"], row["lead_model"]))[:12],
        "defect_owner_rows": sorted(owners.values(), key=lambda row: (-row["total"], row["owner"]))[:12],
        "rejected_reason_rows": [
            {"reason": reason, "count": count}
            for reason, count in sorted(rejected_reasons.items(), key=lambda item: (-item[1], item[0]))[:12]
        ],
        "defect_total": len(rows),
        "in_verification_total": in_verification_total,
        "rejected_total": rejected_total,
    }


def _build_test_sections(conn: sqlite3.Connection, year: str) -> dict[str, Any]:
    columns = _table_columns(conn, "octane_manual_runs")
    if not columns:
        return {
            "test_case_tendency_rows": [],
            "last_week_status_rows": [],
            "test_effort_rows": [],
            "incoming_test_case_rows": [],
            "manual_run_total": 0,
            "planned_total": 0,
        }

    where_clause, params = _year_where(columns, year)
    rows = conn.execute(
        f"""
        SELECT
            TRIM({_optional_expr(columns, 'test_week')}) AS test_week,
            TRIM({_optional_expr(columns, 'test_id')}) AS test_id,
            TRIM({_optional_expr(columns, 'status')}) AS status,
            TRIM({_optional_expr(columns, 'project')}) AS project,
            TRIM({_optional_expr(columns, 'pu')}) AS pu,
            TRIM({_optional_expr(columns, 'started')}) AS started,
            TRIM({_optional_expr(columns, 'finished')}) AS finished
        FROM octane_manual_runs
        WHERE {where_clause}
        """,
        params,
    ).fetchall()

    tendency: dict[str, dict[str, Any]] = {}
    completed_weeks: set[str] = set()
    incoming: dict[tuple[str, str], dict[str, Any]] = {}
    planned_total = 0

    for row in rows:
        week = str(row["test_week"] or "").strip()
        status = str(row["status"] or "").strip()
        is_planned = _status_bucket(status) == "planned" or "future" in week.casefold()
        if is_planned:
            planned_total += 1
            project = str(row["project"] or "Unknown") or "Unknown"
            pu = str(row["pu"] or "Unknown") or "Unknown"
            current_incoming = incoming.setdefault((project, pu), {"project": project, "pu": pu, "planned": 0})
            current_incoming["planned"] += 1
        if _parse_week_key(week) is None:
            continue
        current_tendency = tendency.setdefault(
            week,
            {"test_week": week, "_test_ids": set(), "manual_runs": 0},
        )
        if str(row["test_id"] or "").strip():
            current_tendency["_test_ids"].add(str(row["test_id"]).strip())
        current_tendency["manual_runs"] += 1
        if not is_planned:
            completed_weeks.add(week)

    ordered_weeks = sorted(tendency, key=_week_sort_key)[-6:]
    tendency_rows = [
        {
            "test_week": week,
            "test_cases": len(tendency[week]["_test_ids"]),
            "manual_runs": tendency[week]["manual_runs"],
        }
        for week in ordered_weeks
    ]
    last_completed_week = max(completed_weeks, key=_week_sort_key) if completed_weeks else ""
    last_week_status: dict[str, dict[str, Any]] = {}
    effort: dict[str, dict[str, Any]] = {}
    for row in rows:
        if str(row["test_week"] or "").strip() != last_completed_week:
            continue
        project = str(row["project"] or "Unknown") or "Unknown"
        current_status = last_week_status.setdefault(
            project,
            {"project": project, "passed": 0, "failed": 0, "requires_attention": 0, "planned": 0, "other": 0, "total": 0},
        )
        current_status[_status_bucket(str(row["status"] or ""))] += 1
        current_status["total"] += 1
        if _status_bucket(str(row["status"] or "")) != "planned":
            current_effort = effort.setdefault(project, {"project": project, "test_hours": 0.0, "manual_runs": 0})
            current_effort["test_hours"] = round(current_effort["test_hours"] + _duration_hours(row["started"], row["finished"]), 2)
            current_effort["manual_runs"] += 1

    return {
        "test_case_tendency_rows": tendency_rows,
        "last_week_status_rows": sorted(last_week_status.values(), key=lambda row: (-row["total"], row["project"])),
        "test_effort_rows": sorted(effort.values(), key=lambda row: (-row["test_hours"], row["project"])),
        "incoming_test_case_rows": sorted(incoming.values(), key=lambda row: (-row["planned"], row["project"], row["pu"])),
        "manual_run_total": len(rows),
        "planned_total": planned_total,
    }


def build_qgate_weekly_report_payload(*, db_path: str | Path | None = None, year: str = "") -> dict[str, Any]:
    resolved_db_path = _resolve_db_path(db_path)
    conn = connect(resolved_db_path)
    try:
        conn.row_factory = sqlite3.Row
        selected_year = str(year or "").strip()
        if not selected_year:
            selected_year = _select_latest_year(conn)
        defect_sections = _build_defect_sections(conn, selected_year)
        test_sections = _build_test_sections(conn, selected_year)
    finally:
        conn.close()

    return {
        "generated_from": {"db_path": str(resolved_db_path), "year": selected_year},
        "overview": {
            "defect_total": defect_sections.pop("defect_total"),
            "in_verification_total": defect_sections.pop("in_verification_total"),
            "rejected_total": defect_sections.pop("rejected_total"),
            "manual_run_total": test_sections.pop("manual_run_total"),
            "planned_total": test_sections.pop("planned_total"),
        },
        **defect_sections,
        **test_sections,
    }


def _select_latest_year(conn: sqlite3.Connection) -> str:
    years: set[str] = set()
    for table_name in ("octane_defects", "octane_manual_runs"):
        columns = _table_columns(conn, table_name)
        if "year" not in columns:
            continue
        rows = conn.execute(
            f"""
            SELECT DISTINCT TRIM(COALESCE(CAST(year AS TEXT), '')) AS year
            FROM {table_name}
            WHERE TRIM(COALESCE(CAST(year AS TEXT), '')) <> ''
            """
        ).fetchall()
        years.update(str(row["year"] or "").strip() for row in rows if str(row["year"] or "").strip())
    return sorted(years)[-1] if years else ""