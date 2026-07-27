from __future__ import annotations

import html
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.db import connect
from backend.analytics.ontology import OntologyLoadError, load_ontology


ONTOLOGY_VERSION = "1.0"

CATALOG_SOURCE_TABLES = (
    "octane_defects",
    "octane_manual_runs",
    "octane_run_traceability",
    "octane_traceability_testcases",
    "octane_testcases",
)


def _normalize_text(value: object) -> str:
    return str(value or "").strip()


def _connect_source() -> sqlite3.Connection:
    return connect(get_full_picture_source_db_path())


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_row_count(conn: sqlite3.Connection, table_name: str) -> int:
    if not _table_exists(conn, table_name):
        return 0
    row = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    return int(row[0] or 0) if row is not None else 0


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    if not _table_exists(conn, table_name):
        return set()
    return {str(row[1]).strip() for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _optional_column_expr(columns: set[str], column_name: str) -> str:
    return column_name if column_name in columns else f"'' AS {column_name}"


def _parse_json_object(value: object) -> dict[str, object]:
    text = _normalize_text(value)
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _clean_description(value: object) -> str:
    text = html.unescape(_normalize_text(value))
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:1200]


def _source_table_catalog(conn: sqlite3.Connection | None = None) -> dict[str, dict[str, object]]:
    db_path = get_full_picture_source_db_path()
    if conn is None:
        if not db_path.exists():
            return {table_name: {"exists": False, "rows": 0} for table_name in CATALOG_SOURCE_TABLES}
        local_conn = _connect_source()
        try:
            return _source_table_catalog(local_conn)
        finally:
            local_conn.close()

    return {
        table_name: {"exists": _table_exists(conn, table_name), "rows": _table_row_count(conn, table_name)}
        for table_name in CATALOG_SOURCE_TABLES
    }


def _capability_state(tables: dict[str, dict[str, object]], required_tables: list[str], *, partial: bool = False) -> str:
    has_required = all(bool(tables.get(table_name, {}).get("rows")) for table_name in required_tables)
    if not has_required:
        return "unavailable"
    return "partial" if partial else "available"


def _action_catalog_items() -> list[dict[str, object]]:
    try:
        catalog = load_ontology()
    except OntologyLoadError:
        return []
    return [
        {
            "id": action["id"],
            "operation": action["operation"],
            "target_entity": action["targetEntityId"],
            "capability_state": action["capabilityState"],
            "execution_mode": action["execution"]["mode"],
            "approval_required": bool(action["execution"]["requiresHumanApproval"]),
            "dry_run_required": bool(action["execution"]["requiresDryRun"]),
        }
        for action in catalog.bundle.get("actions", [])
    ]


def build_ontology_catalog_payload() -> dict[str, object]:
    db_path = get_full_picture_source_db_path()
    tables = _source_table_catalog()
    return {
        "ontology_version": ONTOLOGY_VERSION,
        "source": {
            "db_path": str(db_path),
            "tables": tables,
        },
        "entity_types": [
            {
                "id": "Defect",
                "capability_state": _capability_state(tables, ["octane_defects"]),
                "source_tables": ["octane_defects"],
            },
            {
                "id": "Testcase",
                "capability_state": _capability_state(tables, ["octane_manual_runs"]),
                "source_tables": ["octane_manual_runs", "octane_traceability_testcases", "octane_testcases"],
            },
            {
                "id": "ManualRun",
                "capability_state": _capability_state(tables, ["octane_manual_runs"]),
                "source_tables": ["octane_manual_runs"],
            },
            {
                "id": "Feature",
                "capability_state": _capability_state(tables, ["octane_run_traceability"]),
                "source_tables": ["octane_run_traceability"],
            },
            {
                "id": "Story",
                "capability_state": _capability_state(tables, ["octane_run_traceability"]),
                "source_tables": ["octane_run_traceability"],
            },
            {
                "id": "Requirement",
                "capability_state": _capability_state(tables, ["octane_defects"], partial=True),
                "source_tables": ["octane_defects"],
            },
        ],
        "relationship_types": [
            {"id": "EXECUTES_TESTCASE", "from": "ManualRun", "to": "Testcase", "capability_state": _capability_state(tables, ["octane_manual_runs"])},
            {"id": "COVERS_FEATURE", "from": "Testcase", "to": "Feature", "capability_state": _capability_state(tables, ["octane_run_traceability"])},
            {"id": "COVERS_STORY", "from": "Testcase", "to": "Story", "capability_state": _capability_state(tables, ["octane_run_traceability"])},
            {"id": "LINKED_DEFECT", "from": "ManualRun", "to": "Defect", "capability_state": "partial" if tables.get("octane_manual_runs", {}).get("rows") else "unavailable"},
            {"id": "SIMILAR_TO", "from": "Defect", "to": "Defect", "capability_state": "available"},
        ],
        "agent_tools": [
            {"id": "get_test_case_context", "primitive": "context", "capability_state": _capability_state(tables, ["octane_manual_runs", "octane_run_traceability"])},
            {"id": "query_defect_aggregate", "primitive": "aggregate", "capability_state": _capability_state(tables, ["octane_defects"])},
            {"id": "query_defect_records", "primitive": "records", "capability_state": _capability_state(tables, ["octane_defects"])},
            {"id": "search_duplicates", "primitive": "semantic_search", "capability_state": "available"},
        ],
        "actions": _action_catalog_items(),
        "guardrails": [
            "Missing data is unknown, not zero.",
            "Duplicate-search similarity is evidence of similarity, not confirmed causality.",
            "Testcase drafting must call get_test_case_context before generating steps.",
            "Octane write/update/delete intents must be answered from Action Ontology capability states; disabled or blocked actions must not be executed.",
        ],
    }


def _empty_payload(anchor_type: str, anchor_value: str) -> dict[str, object]:
    node_type = "Defect" if anchor_type == "defect_id" else "Testcase"
    node_prefix = "defect" if anchor_type == "defect_id" else "testcase"
    return {
        "anchor": {
            "node_id": f"{node_prefix}:{anchor_value}",
            "node_type": node_type,
            "label": anchor_value,
        },
        "business_scope": {},
        "coverage_summary": {
            "related_testcases": 0,
            "latest_runs": 0,
            "passed": 0,
            "failed": 0,
            "requires_attention": 0,
            "planned": 0,
            "linked_defects": 0,
            "last_verified_week": "",
        },
        "tested_background": [],
        "traceability": {"epics": [], "features": [], "stories": [], "defects": []},
        "gaps": [{"gap_type": "no_related_runs", "description": "No related manual runs were found for this anchor."}],
        "provenance": _provenance(get_full_picture_source_db_path()),
    }


def _provenance(db_path: Path) -> dict[str, str]:
    return {
        "source_db": str(db_path),
        "ontology_version": ONTOLOGY_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _anchor_args(payload: dict[str, Any]) -> tuple[str, str]:
    anchor = payload.get("anchor") if isinstance(payload.get("anchor"), dict) else {}
    anchor_type = _normalize_text(anchor.get("type") or "test_id")
    anchor_value = _normalize_text(anchor.get("value"))
    if anchor_type not in {"test_id", "defect_id"}:
        raise ValueError(f"Unsupported ontology context anchor type: {anchor_type}")
    if not anchor_value:
        raise ValueError("Ontology context anchor value is required")
    return anchor_type, anchor_value


def _rows_for_anchor(conn: sqlite3.Connection, anchor_type: str, anchor_value: str) -> list[sqlite3.Row]:
    if anchor_type == "defect_id":
        return conn.execute(
            """
            SELECT mr_id, defect_id, test_id, test_name, status, year, test_week,
                   pu, top_aida, tester, project, fv, fvp, team, lead_model, fetched_at
            FROM octane_manual_runs
            WHERE TRIM(COALESCE(CAST(defect_id AS TEXT), '')) = ?
            ORDER BY TRIM(COALESCE(CAST(test_week AS TEXT), '')) DESC,
                     TRIM(COALESCE(CAST(fetched_at AS TEXT), '')) DESC,
                     mr_id COLLATE NOCASE
            """,
            (anchor_value,),
        ).fetchall()

    return conn.execute(
        """
        SELECT mr_id, defect_id, test_id, test_name, status, year, test_week,
               pu, top_aida, tester, project, fv, fvp, team, lead_model, fetched_at
        FROM octane_manual_runs
        WHERE TRIM(COALESCE(CAST(test_id AS TEXT), '')) = ?
        ORDER BY TRIM(COALESCE(CAST(test_week AS TEXT), '')) DESC,
                 TRIM(COALESCE(CAST(fetched_at AS TEXT), '')) DESC,
                 mr_id COLLATE NOCASE
        """,
        (anchor_value,),
    ).fetchall()


def _defect_row_for_anchor(conn: sqlite3.Connection, anchor_type: str, anchor_value: str, run_rows: list[sqlite3.Row]) -> dict[str, object]:
    if not _table_exists(conn, "octane_defects"):
        return {}
    defect_id = anchor_value if anchor_type == "defect_id" else ""
    if not defect_id:
        defect_id = _first_value(run_rows, "defect_id")
    if not defect_id:
        return {}

    columns = _table_columns(conn, "octane_defects")
    select_parts = [
        _optional_column_expr(columns, "defect_id"),
        _optional_column_expr(columns, "name"),
        _optional_column_expr(columns, "description"),
        _optional_column_expr(columns, "project"),
        _optional_column_expr(columns, "pu"),
        _optional_column_expr(columns, "top_aida"),
        _optional_column_expr(columns, "product_areas"),
        _optional_column_expr(columns, "fv"),
        _optional_column_expr(columns, "fvp"),
        _optional_column_expr(columns, "team"),
        _optional_column_expr(columns, "problem_finder_team"),
        _optional_column_expr(columns, "lead_model"),
        _optional_column_expr(columns, "assigned_ecu"),
        _optional_column_expr(columns, "solution_cluster"),
        _optional_column_expr(columns, "defect_category"),
        _optional_column_expr(columns, "phase"),
        _optional_column_expr(columns, "requirement"),
        _optional_column_expr(columns, "requirements_json"),
        _optional_column_expr(columns, "raw_json"),
    ]
    row = conn.execute(
        f"SELECT {', '.join(select_parts)} FROM octane_defects WHERE TRIM(COALESCE(CAST(defect_id AS TEXT), '')) = ? LIMIT 1",
        (defect_id,),
    ).fetchone()
    return dict(row) if row is not None else {}


def _traceability_rows(conn: sqlite3.Connection, anchor_type: str, anchor_value: str, run_ids: list[str]) -> list[sqlite3.Row]:
    clauses: list[str] = []
    params: list[str] = []
    if anchor_type == "test_id":
        clauses.append("TRIM(COALESCE(CAST(test_id AS TEXT), '')) = ?")
        params.append(anchor_value)
    else:
        clauses.append("(relation_type = 'defect' AND TRIM(COALESCE(CAST(related_id AS TEXT), '')) = ?)")
        params.append(anchor_value)

    if run_ids:
        placeholders = ", ".join("?" for _ in run_ids)
        clauses.append(f"run_id IN ({placeholders})")
        params.extend(run_ids)

    return conn.execute(
        f"""
        SELECT run_id, test_id, test_name, scope_team, scope_release, source, year, status,
               run_finished, relation_type, related_id, related_name, related_subtype,
               related_path, parent_id, parent_name, parent_subtype, fetched_at
        FROM octane_run_traceability
        WHERE {' OR '.join(clauses)}
        ORDER BY TRIM(COALESCE(CAST(run_finished AS TEXT), '')) DESC,
                 run_id COLLATE NOCASE,
                 relation_type COLLATE NOCASE,
                 related_name COLLATE NOCASE
        """,
        params,
    ).fetchall()


def _first_value(rows: list[sqlite3.Row], key: str) -> str:
    for row in rows:
        value = _normalize_text(row[key])
        if value:
            return value
    return ""


def _status_counts(rows: list[sqlite3.Row]) -> dict[str, int]:
    counts = {"passed": 0, "failed": 0, "requires_attention": 0, "planned": 0}
    for row in rows:
        status = _normalize_text(row["status"]).casefold()
        if "pass" in status:
            counts["passed"] += 1
        elif "fail" in status:
            counts["failed"] += 1
        elif "attention" in status:
            counts["requires_attention"] += 1
        elif "plan" in status:
            counts["planned"] += 1
    return counts


def _dedup_items(items: list[dict[str, str]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        item_id = _normalize_text(item.get("id"))
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        result.append({"id": item_id, "name": _normalize_text(item.get("name")) or item_id})
    return result


def _traceability_payload(rows: list[sqlite3.Row]) -> dict[str, list[dict[str, str]]]:
    epics: list[dict[str, str]] = []
    features: list[dict[str, str]] = []
    stories: list[dict[str, str]] = []
    defects: list[dict[str, str]] = []
    for row in rows:
        relation_type = _normalize_text(row["relation_type"])
        related_id = _normalize_text(row["related_id"])
        related_name = _normalize_text(row["related_name"]) or related_id
        parent_id = _normalize_text(row["parent_id"])
        parent_name = _normalize_text(row["parent_name"]) or parent_id
        parent_subtype = _normalize_text(row["parent_subtype"])
        if relation_type == "feature":
            features.append({"id": related_id, "name": related_name})
            if parent_id and parent_subtype == "epic":
                epics.append({"id": parent_id, "name": parent_name})
        elif relation_type == "story":
            stories.append({"id": related_id, "name": related_name})
            if parent_id:
                features.append({"id": parent_id, "name": parent_name})
        elif relation_type == "defect":
            defects.append({"id": related_id, "name": related_name})
    return {
        "epics": _dedup_items(epics),
        "features": _dedup_items(features),
        "stories": _dedup_items(stories),
        "defects": _dedup_items(defects),
    }


def _linked_defect_ids(run_rows: list[sqlite3.Row], trace_payload: dict[str, list[dict[str, str]]]) -> set[str]:
    defect_ids = {
        _normalize_text(row["defect_id"])
        for row in run_rows
        if _normalize_text(row["defect_id"])
    }
    defect_ids.update(_normalize_text(item.get("id")) for item in trace_payload["defects"] if _normalize_text(item.get("id")))
    return defect_ids


def _gaps(status_counts: dict[str, int], trace_payload: dict[str, list[dict[str, str]]], run_count: int) -> list[dict[str, str]]:
    gaps: list[dict[str, str]] = []
    if run_count == 0:
        gaps.append({"gap_type": "no_related_runs", "description": "No related manual runs were found for this anchor."})
    if status_counts["failed"] or status_counts["requires_attention"]:
        gaps.append(
            {
                "gap_type": "failed_related_run",
                "description": "Related testcase has failed or requires-attention runs.",
            }
        )
    if not trace_payload["features"] and not trace_payload["stories"]:
        gaps.append(
            {
                "gap_type": "missing_traceability",
                "description": "No Feature or Story traceability was found for this anchor.",
            }
        )
    return gaps


def _defect_context(defect_row: dict[str, object]) -> dict[str, object]:
    defect_id = _normalize_text(defect_row.get("defect_id"))
    if not defect_id:
        return {}
    raw_payload = _parse_json_object(defect_row.get("raw_json"))
    raw_description = defect_row.get("description") or raw_payload.get("description")
    return {
        "defect_id": defect_id,
        "name": _normalize_text(defect_row.get("name")) or defect_id,
        "description": _clean_description(raw_description),
        "requirement": _normalize_text(defect_row.get("requirement")),
        "evidence": [f"defect:{defect_id}"],
    }


def build_test_case_context_payload(payload: dict[str, Any] | None = None) -> dict[str, object]:
    raw_payload = payload if isinstance(payload, dict) else {}
    anchor_type, anchor_value = _anchor_args(raw_payload)
    db_path = get_full_picture_source_db_path()
    if not db_path.exists():
        return _empty_payload(anchor_type, anchor_value)

    conn = _connect_source()
    try:
        if not _table_exists(conn, "octane_manual_runs") or not _table_exists(conn, "octane_run_traceability"):
            return _empty_payload(anchor_type, anchor_value)

        run_rows = _rows_for_anchor(conn, anchor_type, anchor_value)
        defect_row = _defect_row_for_anchor(conn, anchor_type, anchor_value, run_rows)
        run_ids = [_normalize_text(row["mr_id"]) for row in run_rows if _normalize_text(row["mr_id"])]
        trace_rows = _traceability_rows(conn, anchor_type, anchor_value, run_ids)
        trace_payload = _traceability_payload(trace_rows)
        status_counts = _status_counts(run_rows)
        anchor_label = _first_value(run_rows, "test_name") or _normalize_text(defect_row.get("name")) or anchor_value
        node_type = "Defect" if anchor_type == "defect_id" else "Testcase"
        node_prefix = "defect" if anchor_type == "defect_id" else "testcase"
        latest_week = _first_value(run_rows, "test_week")
        latest_status = _first_value(run_rows, "status")
        related_test_ids = {
            _normalize_text(row["test_id"])
            for row in run_rows
            if _normalize_text(row["test_id"])
        }
        related_test_ids.update(
            _normalize_text(row["test_id"])
            for row in trace_rows
            if _normalize_text(row["test_id"])
        )
        linked_defects = _linked_defect_ids(run_rows, trace_payload)
        release = _first_value(trace_rows, "scope_release")

        project = _first_value(run_rows, "project") or _normalize_text(defect_row.get("project"))
        pu = _first_value(run_rows, "pu") or _normalize_text(defect_row.get("pu"))
        aida = _first_value(run_rows, "top_aida") or _normalize_text(defect_row.get("top_aida")) or _normalize_text(defect_row.get("product_areas"))
        fv = _first_value(run_rows, "fv") or _normalize_text(defect_row.get("fv"))
        fvp = _first_value(run_rows, "fvp") or _normalize_text(defect_row.get("fvp"))
        team = _first_value(run_rows, "team") or _first_value(trace_rows, "scope_team") or _normalize_text(defect_row.get("team")) or _normalize_text(defect_row.get("problem_finder_team"))
        lead_model = _first_value(run_rows, "lead_model") or _normalize_text(defect_row.get("lead_model"))

        payload = {
            "anchor": {"node_id": f"{node_prefix}:{anchor_value}", "node_type": node_type, "label": anchor_label},
            "business_scope": {
                "project": project,
                "pu": pu,
                "aida": aida,
                "fv": fv,
                "fvp": fvp,
                "team": team,
                "lead_model": lead_model,
                "release": release,
                "planned_week": latest_week,
            },
            "coverage_summary": {
                "related_testcases": len(related_test_ids),
                "latest_runs": len(run_rows),
                **status_counts,
                "linked_defects": len(linked_defects),
                "last_verified_week": latest_week,
            },
            "tested_background": [
                {
                    "test_id": _first_value(run_rows, "test_id") or anchor_value,
                    "test_name": anchor_label,
                    "last_status": latest_status,
                    "last_week": latest_week,
                    "evidence": [f"manual_run:{run_id}" for run_id in run_ids],
                }
            ] if run_rows else [],
            "traceability": trace_payload,
            "gaps": _gaps(status_counts, trace_payload, len(run_rows)),
            "provenance": _provenance(db_path),
        }
        defect_context = _defect_context(defect_row)
        if defect_context:
            payload["defect_context"] = defect_context
        return payload
    finally:
        conn.close()