from __future__ import annotations

import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.db import connect
from backend.analytics.ontology import OntologyLoadError, load_ontology


_PLAN_CW_RE = re.compile(r"(?:^|[^A-Za-z0-9])(?:(20\d{2})[-_ ]*)?CW\s*0?(\d{1,2})(?:$|[^A-Za-z0-9])", re.IGNORECASE)
_PLAN_SET_RE = re.compile(r"SET[_ -]*0?(\d{1,2})[-_ ]*\d{2}", re.IGNORECASE)


def _connect_source() -> sqlite3.Connection:
    return connect(get_full_picture_source_db_path())


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _normalize_week_year(value: object) -> str:
    raw_value = str(value or "").strip()
    if re.fullmatch(r"20\d{2}", raw_value):
        return raw_value
    match = re.search(r"20\d{2}", raw_value)
    if match:
        return match.group(0)
    return ""


def _format_traceability_week(year: object, week: object) -> str:
    normalized_year = _normalize_week_year(year)
    if not normalized_year:
        return ""
    try:
        week_number = int(str(week or "").strip())
    except ValueError:
        return ""
    if week_number < 1 or week_number > 53:
        return ""
    return f"{normalized_year}-CW{week_number:02d}"


def _derive_traceability_week(*values: object) -> str:
    raw_week = str(values[0] if values else "").strip()
    if raw_week:
        return raw_week
    for value in values[1:]:
        raw_value = str(value or "").strip()
        if not raw_value:
            continue
        timestamp = raw_value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(timestamp)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(timestamp[:10])
            except ValueError:
                continue
        iso_year, iso_week, _ = parsed.isocalendar()
        return f"{iso_year}-CW{iso_week:02d}"
    return ""


def _derive_traceability_plan_week(year: object, *values: object) -> str:
    fallback_year = _normalize_week_year(year)
    for value in values:
        text = str(value or "")
        for match in _PLAN_CW_RE.finditer(text):
            week = _format_traceability_week(match.group(1) or fallback_year, match.group(2))
            if week:
                return week
    for value in values:
        text = str(value or "")
        for match in _PLAN_SET_RE.finditer(text):
            week = _format_traceability_week(fallback_year, match.group(1))
            if week:
                return week
    return ""


def _register_traceability_functions(conn: sqlite3.Connection) -> None:
    conn.create_function("traceability_week", 5, _derive_traceability_week)
    conn.create_function("traceability_plan_week", 4, _derive_traceability_plan_week)


def _manual_week_expression(alias: str = "mr") -> str:
    return f"traceability_week({alias}.test_week, {alias}.finished, {alias}.started, {alias}.last_modified, {alias}.creation_time)"


def _trace_plan_week_expression(alias: str = "rt") -> str:
    return f"traceability_plan_week({alias}.year, {alias}.related_name, {alias}.parent_name, {alias}.test_name)"


def _normalize_values(raw_values: Any) -> tuple[str, ...]:
    if raw_values is None:
        return ()
    if isinstance(raw_values, str):
        items = raw_values.split(",")
    else:
        items = list(raw_values)
    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        for part in str(item).split(","):
            value = part.strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
    return tuple(normalized)


def _get_values(query_params: Any, key: str) -> tuple[str, ...]:
    if hasattr(query_params, "getlist"):
        return _normalize_values(query_params.getlist(key))
    if isinstance(query_params, dict):
        return _normalize_values(query_params.get(key))
    return ()


def _build_manual_where(
    query_params: Any,
    alias: str = "mr",
    excluded_keys: set[str] | None = None,
) -> tuple[str, list[str]]:
    clauses = ["1=1"]
    params: list[str] = []
    excluded = excluded_keys or set()
    filters = (
        ("years", f"TRIM(COALESCE(CAST({alias}.year AS TEXT), ''))"),
        ("teams", f"TRIM(COALESCE(NULLIF(CAST({alias}.run_team AS TEXT), ''), NULLIF(CAST({alias}.team AS TEXT), ''), ''))"),
        ("statuses", f"TRIM(COALESCE(CAST({alias}.status AS TEXT), ''))"),
        ("weeks", _manual_week_expression(alias)),
    )
    for key, expression in filters:
        if key in excluded:
            continue
        values = _get_values(query_params, key)
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        clauses.append(f"{expression} IN ({placeholders})")
        params.extend(values)
    search_values = _get_values(query_params, "search")
    if search_values:
        search_text = f"%{search_values[0].casefold()}%"
        clauses.append(
            f"(LOWER(TRIM(COALESCE(CAST({alias}.test_id AS TEXT), ''))) LIKE ? OR LOWER(TRIM(COALESCE(CAST({alias}.test_name AS TEXT), ''))) LIKE ?)"
        )
        params.extend([search_text, search_text])
    return " AND ".join(clauses), params


def _build_trace_where(
    query_params: Any,
    alias: str = "rt",
    excluded_keys: set[str] | None = None,
) -> tuple[str, list[str]]:
    clauses = ["1=1"]
    params: list[str] = []
    excluded = excluded_keys or set()
    filters = (
        ("years", f"TRIM(COALESCE(CAST({alias}.year AS TEXT), ''))"),
        ("teams", f"TRIM(COALESCE(CAST({alias}.scope_team AS TEXT), ''))"),
        ("releases", f"TRIM(COALESCE(CAST({alias}.scope_release AS TEXT), ''))"),
        ("statuses", f"TRIM(COALESCE(CAST({alias}.status AS TEXT), ''))"),
        ("relation_types", f"TRIM(COALESCE(CAST({alias}.relation_type AS TEXT), ''))"),
    )
    for key, expression in filters:
        if key in excluded:
            continue
        values = _get_values(query_params, key)
        if not values:
            continue
        placeholders = ", ".join("?" for _ in values)
        clauses.append(f"{expression} IN ({placeholders})")
        params.extend(values)
    aida_values = () if "aidas" in excluded else _get_values(query_params, "aidas")
    if aida_values:
        placeholders = ", ".join("?" for _ in aida_values)
        clauses.append(
            f"(TRIM(COALESCE(CAST({alias}.related_id AS TEXT), '')) IN ({placeholders}) "
            f"OR TRIM(COALESCE(CAST({alias}.parent_id AS TEXT), '')) IN ({placeholders}))"
        )
        params.extend(aida_values)
        params.extend(aida_values)
    search_values = _get_values(query_params, "search")
    if search_values:
        search_text = f"%{search_values[0].casefold()}%"
        clauses.append(
            f"(LOWER(TRIM(COALESCE(CAST({alias}.test_id AS TEXT), ''))) LIKE ? OR LOWER(TRIM(COALESCE(CAST({alias}.test_name AS TEXT), ''))) LIKE ? OR LOWER(TRIM(COALESCE(CAST({alias}.related_name AS TEXT), ''))) LIKE ?)"
        )
        params.extend([search_text, search_text, search_text])
    week_values = () if "weeks" in excluded else _get_values(query_params, "weeks")
    if week_values:
        placeholders = ", ".join("?" for _ in week_values)
        plan_week_expression = _trace_plan_week_expression("week_rt")
        manual_week_expression = _manual_week_expression("week_mr")
        clauses.append(
            f"""
            (
                {alias}.run_id IN (
                    SELECT DISTINCT week_rt.run_id
                    FROM octane_run_traceability week_rt
                    WHERE COALESCE(week_rt.run_id, '') <> ''
                      AND {plan_week_expression} IN ({placeholders})
                )
                OR (
                    {alias}.run_id NOT IN (
                        SELECT DISTINCT week_rt.run_id
                        FROM octane_run_traceability week_rt
                        WHERE COALESCE(week_rt.run_id, '') <> ''
                          AND {plan_week_expression} <> ''
                    )
                    AND {alias}.run_id IN (
                        SELECT week_mr.mr_id
                        FROM octane_manual_runs week_mr
                        WHERE {manual_week_expression} IN ({placeholders})
                    )
                )
            )
            """
        )
        params.extend(week_values)
        params.extend(week_values)
    return " AND ".join(clauses), params


def _to_percent(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round((numerator / denominator) * 100.0, 2)


def _has_trace_relation_filter(query_params: Any) -> bool:
    return any(_get_values(query_params, key) for key in ("releases", "aidas", "relation_types"))


GRAPH_LAYERS = ["epic", "feature", "story", "testcase", "manual_run", "defect"]
TRACEABILITY_EDGE_RELATIONSHIPS = {
    ("epic", "feature"): "requirements.aida_node.parent_of.aida_node",
    ("feature", "story"): "requirements.aida_node.parent_of.aida_node",
    ("feature", "testcase"): "testing.test_run.traces_to.feature",
    ("story", "testcase"): "testing.test_run.traces_to.story",
    ("testcase", "manual_run"): "testing.test_run.executes.test_case",
    ("manual_run", "defect"): "quality.defect.detected_in.test_run",
}


def _ontology_relationship_ids() -> set[str]:
    try:
        catalog = load_ontology()
    except OntologyLoadError:
        return set()
    return {str(item.get("id") or "") for item in catalog.bundle.get("relationships", [])}


def _edge_relationship_id(from_id: str, to_id: str, known_relationship_ids: set[str]) -> str:
    from_type = str(from_id or "").split(":", 1)[0]
    to_type = str(to_id or "").split(":", 1)[0]
    relationship_id = TRACEABILITY_EDGE_RELATIONSHIPS.get((from_type, to_type), "")
    return relationship_id if relationship_id in known_relationship_ids else ""


def _empty_graph() -> dict[str, object]:
    return {"layers": GRAPH_LAYERS, "nodes": [], "edges": []}


def _split_csv_values(value: object) -> list[str]:
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


def _paired_ids_and_names(ids: object, names: object) -> list[tuple[str, str]]:
    id_values = _split_csv_values(ids)
    name_values = _split_csv_values(names)
    pairs: list[tuple[str, str]] = []
    for index, item_id in enumerate(id_values):
        item_name = name_values[index] if index < len(name_values) else item_id
        pairs.append((item_id, item_name or item_id))
    return pairs


def _build_traceability_graph(chain_rows: list[dict[str, object]]) -> dict[str, object]:
    nodes_by_id: dict[str, dict[str, object]] = {}
    edges_by_id: dict[str, dict[str, object]] = {}

    def add_node(node_type: str, raw_id: str, label: str, secondary_label: str = "", status: str = "") -> str:
        node_id = f"{node_type}:{raw_id}"
        node = nodes_by_id.get(node_id)
        if node is None:
            nodes_by_id[node_id] = {
                "id": node_id,
                "type": node_type,
                "label": label or raw_id,
                "secondary_label": secondary_label or raw_id,
                "status": status,
                "count": 1,
            }
        else:
            if not node.get("status") and status:
                node["status"] = status
        return node_id

    known_relationship_ids = _ontology_relationship_ids()

    def add_edge(from_id: str, to_id: str) -> None:
        if not from_id or not to_id:
            return
        edge_id = f"{from_id}->{to_id}"
        relationship_id = _edge_relationship_id(from_id, to_id, known_relationship_ids)
        edge = edges_by_id.get(edge_id)
        if edge is None:
            edges_by_id[edge_id] = {"id": edge_id, "from": from_id, "to": to_id, "count": 1, "relationship_id": relationship_id}
        else:
            edge["count"] = int(edge["count"] or 0) + 1
            if not edge.get("relationship_id") and relationship_id:
                edge["relationship_id"] = relationship_id

    for row in chain_rows:
        epic_nodes = [
            add_node("epic", item_id, item_name, item_id)
            for item_id, item_name in _paired_ids_and_names(row.get("epic_ids"), row.get("epic_names"))
        ]
        feature_nodes = [
            add_node("feature", item_id, item_name, item_id)
            for item_id, item_name in _paired_ids_and_names(row.get("feature_ids"), row.get("feature_names"))
        ]
        story_nodes = [
            add_node("story", item_id, item_name, item_id)
            for item_id, item_name in _paired_ids_and_names(row.get("story_ids"), row.get("story_names"))
        ]
        defect_nodes = [
            add_node("defect", item_id, item_name, item_id)
            for item_id, item_name in _paired_ids_and_names(row.get("defect_ids"), row.get("defect_names"))
        ]
        test_id = str(row.get("test_id") or "").strip()
        run_id = str(row.get("run_id") or "").strip()
        testcase_node = ""
        manual_run_node = ""
        if test_id:
            testcase_node = add_node("testcase", test_id, str(row.get("test_name") or test_id), test_id)
        if run_id:
            manual_run_node = add_node(
                "manual_run",
                run_id,
                str(row.get("test_name") or run_id),
                run_id,
                str(row.get("run_status") or ""),
            )

        for epic_node in epic_nodes:
            for feature_node in feature_nodes:
                add_edge(epic_node, feature_node)
        for parent_node in feature_nodes or epic_nodes:
            for story_node in story_nodes:
                add_edge(parent_node, story_node)
        for parent_node in story_nodes or feature_nodes or epic_nodes:
            add_edge(parent_node, testcase_node)
        add_edge(testcase_node, manual_run_node)
        defect_parent_node = manual_run_node or testcase_node
        for defect_node in defect_nodes:
            add_edge(defect_parent_node, defect_node)

    nodes = sorted(
        nodes_by_id.values(),
        key=lambda node: (GRAPH_LAYERS.index(str(node["type"])), str(node["label"]).casefold(), str(node["id"])),
    )
    edges = sorted(
        edges_by_id.values(),
        key=lambda edge: (
            GRAPH_LAYERS.index(str(edge["from"]).split(":", 1)[0]),
            str(edge["from"]),
            GRAPH_LAYERS.index(str(edge["to"]).split(":", 1)[0]),
            str(edge["to"]),
        ),
    )
    return {"layers": GRAPH_LAYERS, "nodes": nodes, "edges": edges}


def _build_traceability_graph_from_relations(relation_rows: list[dict[str, object]]) -> dict[str, object]:
    nodes_by_id: dict[str, dict[str, object]] = {}
    edges_by_id: dict[str, dict[str, object]] = {}
    run_edges: dict[str, tuple[str, str]] = {}
    runs_with_stories = {
        str(row.get("run_id") or "").strip()
        for row in relation_rows
        if row.get("relation_type") == "story"
    }

    def add_node(node_type: str, raw_id: str, label: str, secondary_label: str = "", status: str = "") -> str:
        node_id = f"{node_type}:{raw_id}"
        node = nodes_by_id.get(node_id)
        if node is None:
            nodes_by_id[node_id] = {
                "id": node_id,
                "type": node_type,
                "label": label or raw_id,
                "secondary_label": secondary_label or raw_id,
                "status": status,
                "count": 1,
            }
        else:
            if not node.get("status") and status:
                node["status"] = status
        return node_id

    known_relationship_ids = _ontology_relationship_ids()

    def add_edge(from_id: str, to_id: str) -> None:
        if not from_id or not to_id:
            return
        edge_id = f"{from_id}->{to_id}"
        relationship_id = _edge_relationship_id(from_id, to_id, known_relationship_ids)
        edge = edges_by_id.get(edge_id)
        if edge is None:
            edges_by_id[edge_id] = {"id": edge_id, "from": from_id, "to": to_id, "count": 1, "relationship_id": relationship_id}
        else:
            edge["count"] = int(edge["count"] or 0) + 1
            if not edge.get("relationship_id") and relationship_id:
                edge["relationship_id"] = relationship_id

    for row in relation_rows:
        run_id = str(row.get("run_id") or "").strip()
        test_id = str(row.get("test_id") or "").strip()
        test_name = str(row.get("test_name") or "").strip()
        run_status = str(row.get("status") or "").strip()
        relation_type = str(row.get("relation_type") or "").strip()
        related_id = str(row.get("related_id") or "").strip()
        related_name = str(row.get("related_name") or "").strip()
        parent_id = str(row.get("parent_id") or "").strip()
        parent_name = str(row.get("parent_name") or "").strip()

        testcase_node = add_node("testcase", test_id, test_name or test_id, test_id) if test_id else ""
        manual_run_node = add_node("manual_run", run_id, test_name or run_id, run_id, run_status) if run_id else ""
        if run_id and testcase_node and manual_run_node:
            run_edges[run_id] = (testcase_node, manual_run_node)

        if relation_type == "feature" and related_id:
            feature_node = add_node("feature", related_id, related_name or related_id, related_id)
            if parent_id:
                epic_node = add_node("epic", parent_id, parent_name or parent_id, parent_id)
                add_edge(epic_node, feature_node)
            if run_id not in runs_with_stories:
                add_edge(feature_node, testcase_node)
        elif relation_type == "story" and related_id:
            story_node = add_node("story", related_id, related_name or related_id, related_id)
            if parent_id:
                feature_node = add_node("feature", parent_id, parent_name or parent_id, parent_id)
                add_edge(feature_node, story_node)
            add_edge(story_node, testcase_node)
        elif relation_type == "defect" and related_id:
            defect_node = add_node("defect", related_id, related_name or related_id, related_id)
            add_edge(manual_run_node, defect_node)

    for testcase_node, manual_run_node in run_edges.values():
        add_edge(testcase_node, manual_run_node)

    nodes = sorted(
        nodes_by_id.values(),
        key=lambda node: (GRAPH_LAYERS.index(str(node["type"])), str(node["label"]).casefold(), str(node["id"])),
    )
    edges = sorted(
        edges_by_id.values(),
        key=lambda edge: (
            GRAPH_LAYERS.index(str(edge["from"]).split(":", 1)[0]),
            str(edge["from"]),
            GRAPH_LAYERS.index(str(edge["to"]).split(":", 1)[0]),
            str(edge["to"]),
        ),
    )
    return {"layers": GRAPH_LAYERS, "nodes": nodes, "edges": edges}


def _empty_payload() -> dict[str, object]:
    return {
        "summary": {
            "total_runs": 0,
            "traced_runs": 0,
            "total_testcases": 0,
            "traced_testcases": 0,
            "traceability_rate": 0.0,
            "feature_count": 0,
            "story_count": 0,
            "defect_count": 0,
            "relation_rows": 0,
        },
        "filter_options": {"years": [], "teams": [], "releases": [], "weeks": [], "statuses": [], "relation_types": []},
        "relation_type_rows": [],
        "status_rows": [],
        "top_related_items": [],
        "traceability_chain_rows": [],
        "graph": _empty_graph(),
        "testcase_rows": [],
        "gap_rows": [],
    }


def build_traceability_analysis_payload(query_params: Any = None) -> dict[str, object]:
    query_params = query_params or {}
    include_internal_fields = bool(query_params.get("__include_internal_fields", False))
    db_path = get_full_picture_source_db_path()
    if not Path(db_path).exists():
        return _empty_payload()

    conn = _connect_source()
    try:
        _register_traceability_functions(conn)
        if not _table_exists(conn, "octane_manual_runs") or not _table_exists(conn, "octane_run_traceability"):
            return _empty_payload()

        has_trace_relation_filter = _has_trace_relation_filter(query_params or {})
        manual_excluded_keys = {"weeks"} if has_trace_relation_filter else None
        manual_where, manual_params = _build_manual_where(query_params, excluded_keys=manual_excluded_keys)
        trace_where, trace_params = _build_trace_where(query_params)

        if has_trace_relation_filter:
            scoped_manual_from = f"""
                octane_manual_runs mr
                INNER JOIN (
                    SELECT DISTINCT rt.run_id
                    FROM octane_run_traceability rt
                    WHERE {trace_where}
                ) scoped_rt ON scoped_rt.run_id = mr.mr_id
            """
            scoped_manual_params = [*trace_params, *manual_params]
        else:
            scoped_manual_from = "octane_manual_runs mr"
            scoped_manual_params = manual_params

        manual_summary = conn.execute(
            f"""
            SELECT
                COUNT(DISTINCT mr.mr_id) AS total_runs,
                COUNT(DISTINCT NULLIF(TRIM(COALESCE(CAST(mr.test_id AS TEXT), '')), '')) AS total_testcases
            FROM {scoped_manual_from}
            WHERE {manual_where}
            """,
            scoped_manual_params,
        ).fetchone()
        trace_summary = conn.execute(
            f"""
            SELECT
                COUNT(*) AS relation_rows,
                COUNT(DISTINCT rt.run_id) AS traced_runs,
                COUNT(DISTINCT rt.test_id) AS traced_testcases,
                COUNT(DISTINCT CASE WHEN rt.relation_type = 'feature' THEN rt.related_id END) AS feature_count,
                COUNT(DISTINCT CASE WHEN rt.relation_type = 'story' THEN rt.related_id END) AS story_count,
                COUNT(DISTINCT CASE WHEN rt.relation_type = 'defect' THEN rt.related_id END) AS defect_count
            FROM octane_run_traceability rt
            WHERE {trace_where}
            """,
            trace_params,
        ).fetchone()

        total_runs = int(manual_summary["total_runs"] or 0)
        traced_runs = int(trace_summary["traced_runs"] or 0)
        summary = {
            "total_runs": total_runs,
            "traced_runs": traced_runs,
            "total_testcases": int(manual_summary["total_testcases"] or 0),
            "traced_testcases": int(trace_summary["traced_testcases"] or 0),
            "traceability_rate": _to_percent(traced_runs, total_runs),
            "feature_count": int(trace_summary["feature_count"] or 0),
            "story_count": int(trace_summary["story_count"] or 0),
            "defect_count": int(trace_summary["defect_count"] or 0),
            "relation_rows": int(trace_summary["relation_rows"] or 0),
        }

        relation_type_rows = [
            {
                "relation_type": str(row["relation_type"] or ""),
                "run_count": int(row["run_count"] or 0),
                "testcase_count": int(row["testcase_count"] or 0),
                "related_count": int(row["related_count"] or 0),
            }
            for row in conn.execute(
                f"""
                SELECT relation_type,
                       COUNT(DISTINCT run_id) AS run_count,
                       COUNT(DISTINCT test_id) AS testcase_count,
                       COUNT(DISTINCT related_id) AS related_count
                FROM octane_run_traceability rt
                WHERE {trace_where}
                GROUP BY relation_type
                ORDER BY relation_type COLLATE NOCASE
                """,
                trace_params,
            ).fetchall()
        ]

        if has_trace_relation_filter:
            status_sql = f"""
                SELECT TRIM(COALESCE(CAST(mr.status AS TEXT), '')) AS status,
                       COUNT(DISTINCT mr.mr_id) AS total_runs,
                       COUNT(DISTINCT mr.mr_id) AS traced_runs
                FROM {scoped_manual_from}
                WHERE {manual_where}
                GROUP BY TRIM(COALESCE(CAST(mr.status AS TEXT), ''))
                ORDER BY total_runs DESC, status COLLATE NOCASE
            """
            status_params = scoped_manual_params
        else:
            status_sql = f"""
                SELECT TRIM(COALESCE(CAST(mr.status AS TEXT), '')) AS status,
                       COUNT(DISTINCT mr.mr_id) AS total_runs,
                       COUNT(DISTINCT rt.run_id) AS traced_runs
                FROM octane_manual_runs mr
                LEFT JOIN octane_run_traceability rt ON rt.run_id = mr.mr_id
                WHERE {manual_where}
                GROUP BY TRIM(COALESCE(CAST(mr.status AS TEXT), ''))
                ORDER BY total_runs DESC, status COLLATE NOCASE
            """
            status_params = manual_params

        status_rows = [
            {
                "status": str(row["status"] or ""),
                "total_runs": int(row["total_runs"] or 0),
                "traced_runs": int(row["traced_runs"] or 0),
            }
            for row in conn.execute(status_sql, status_params).fetchall()
        ]

        top_related_items = [
            {
                "relation_type": str(row["relation_type"] or ""),
                "related_id": str(row["related_id"] or ""),
                "related_name": str(row["related_name"] or ""),
                "parent_name": str(row["parent_name"] or ""),
                "run_count": int(row["run_count"] or 0),
                "testcase_count": int(row["testcase_count"] or 0),
                "failed_runs": int(row["failed_runs"] or 0),
                "passed_runs": int(row["passed_runs"] or 0),
            }
            for row in conn.execute(
                f"""
                SELECT relation_type, related_id, related_name, parent_name,
                       COUNT(DISTINCT run_id) AS run_count,
                       COUNT(DISTINCT test_id) AS testcase_count,
                       SUM(CASE WHEN LOWER(status) LIKE '%fail%' THEN 1 ELSE 0 END) AS failed_runs,
                       SUM(CASE WHEN LOWER(status) LIKE '%pass%' THEN 1 ELSE 0 END) AS passed_runs
                FROM octane_run_traceability rt
                WHERE {trace_where}
                GROUP BY relation_type, related_id, related_name, parent_name
                ORDER BY run_count DESC, relation_type COLLATE NOCASE, related_name COLLATE NOCASE
                LIMIT 20
                """,
                trace_params,
            ).fetchall()
        ]

        traceability_chain_rows = [
            {
                "epic_ids": str(row["epic_ids"] or ""),
                "epic_names": str(row["epic_names"] or ""),
                "feature_ids": str(row["feature_ids"] or ""),
                "feature_names": str(row["feature_names"] or ""),
                "story_ids": str(row["story_ids"] or ""),
                "story_names": str(row["story_names"] or ""),
                "defect_ids": str(row["defect_ids"] or ""),
                "defect_names": str(row["defect_names"] or ""),
                "test_id": str(row["test_id"] or ""),
                "test_name": str(row["test_name"] or ""),
                "run_id": str(row["run_id"] or ""),
                "run_status": str(row["run_status"] or ""),
                **({"run_finished": str(row["run_finished"] or "")} if include_internal_fields else {}),
                "scope_team": str(row["scope_team"] or ""),
                "scope_release": str(row["scope_release"] or ""),
            }
            for row in conn.execute(
                f"""
                SELECT
                    rt.run_id,
                    rt.test_id,
                    MAX(rt.test_name) AS test_name,
                    MAX(rt.status) AS run_status,
                    MAX(rt.run_finished) AS run_finished,
                    rt.scope_team,
                    rt.scope_release,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'feature' THEN NULLIF(TRIM(COALESCE(CAST(rt.parent_id AS TEXT), '')), '') END) AS epic_ids,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'feature' THEN COALESCE(NULLIF(TRIM(COALESCE(CAST(rt.parent_name AS TEXT), '')), ''), NULLIF(TRIM(COALESCE(CAST(rt.parent_id AS TEXT), '')), '')) END) AS epic_names,
                    GROUP_CONCAT(DISTINCT CASE
                        WHEN rt.relation_type = 'feature' THEN NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), '')
                        WHEN rt.relation_type = 'story' THEN NULLIF(TRIM(COALESCE(CAST(rt.parent_id AS TEXT), '')), '')
                    END) AS feature_ids,
                    GROUP_CONCAT(DISTINCT CASE
                        WHEN rt.relation_type = 'feature' THEN COALESCE(NULLIF(TRIM(COALESCE(CAST(rt.related_name AS TEXT), '')), ''), NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), ''))
                        WHEN rt.relation_type = 'story' THEN COALESCE(NULLIF(TRIM(COALESCE(CAST(rt.parent_name AS TEXT), '')), ''), NULLIF(TRIM(COALESCE(CAST(rt.parent_id AS TEXT), '')), ''))
                    END) AS feature_names,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'story' THEN NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), '') END) AS story_ids,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'story' THEN COALESCE(NULLIF(TRIM(COALESCE(CAST(rt.related_name AS TEXT), '')), ''), NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), '')) END) AS story_names,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'defect' THEN NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), '') END) AS defect_ids,
                    GROUP_CONCAT(DISTINCT CASE WHEN rt.relation_type = 'defect' THEN COALESCE(NULLIF(TRIM(COALESCE(CAST(rt.related_name AS TEXT), '')), ''), NULLIF(TRIM(COALESCE(CAST(rt.related_id AS TEXT), '')), '')) END) AS defect_names
                FROM octane_run_traceability rt
                WHERE {trace_where}
                GROUP BY rt.run_id, rt.test_id, rt.scope_team, rt.scope_release
                ORDER BY COALESCE(MAX(rt.run_finished), '') DESC, rt.run_id COLLATE NOCASE
                """,
                trace_params,
            ).fetchall()
        ]

        graph_relation_rows = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT
                    rt.run_id,
                    rt.test_id,
                    rt.test_name,
                    rt.status,
                    rt.relation_type,
                    rt.related_id,
                    rt.related_name,
                    rt.related_path,
                    rt.parent_id,
                    rt.parent_name
                FROM octane_run_traceability rt
                WHERE {trace_where}
                ORDER BY COALESCE(rt.run_finished, '') DESC, rt.run_id COLLATE NOCASE, rt.relation_type COLLATE NOCASE
                """,
                trace_params,
            ).fetchall()
        ]

        testcase_rows = [
            {
                "test_id": str(row["test_id"] or ""),
                "test_name": str(row["test_name"] or ""),
                "run_count": int(row["run_count"] or 0),
                "relation_count": int(row["relation_count"] or 0),
                "feature_count": int(row["feature_count"] or 0),
                "story_count": int(row["story_count"] or 0),
                "defect_count": int(row["defect_count"] or 0),
            }
            for row in conn.execute(
                f"""
                SELECT test_id,
                       MAX(test_name) AS test_name,
                       COUNT(DISTINCT run_id) AS run_count,
                       COUNT(*) AS relation_count,
                       COUNT(DISTINCT CASE WHEN relation_type = 'feature' THEN related_id END) AS feature_count,
                       COUNT(DISTINCT CASE WHEN relation_type = 'story' THEN related_id END) AS story_count,
                       COUNT(DISTINCT CASE WHEN relation_type = 'defect' THEN related_id END) AS defect_count
                FROM octane_run_traceability rt
                WHERE {trace_where}
                GROUP BY test_id
                ORDER BY relation_count DESC, test_id COLLATE NOCASE
                LIMIT 50
                """,
                trace_params,
            ).fetchall()
        ]

        if has_trace_relation_filter:
            gap_rows = []
        else:
            gap_rows = [
                {
                    "test_id": str(row["test_id"] or ""),
                    "test_name": str(row["test_name"] or ""),
                    "run_count": int(row["run_count"] or 0),
                    "latest_status": str(row["latest_status"] or ""),
                    "project": str(row["project"] or ""),
                    "team": str(row["team"] or ""),
                }
                for row in conn.execute(
                    f"""
                    SELECT TRIM(COALESCE(CAST(mr.test_id AS TEXT), '')) AS test_id,
                           MAX(TRIM(COALESCE(CAST(mr.test_name AS TEXT), ''))) AS test_name,
                           COUNT(DISTINCT mr.mr_id) AS run_count,
                           MAX(TRIM(COALESCE(CAST(mr.status AS TEXT), ''))) AS latest_status,
                           MAX(TRIM(COALESCE(CAST(mr.project AS TEXT), ''))) AS project,
                           MAX(TRIM(COALESCE(NULLIF(CAST(mr.run_team AS TEXT), ''), NULLIF(CAST(mr.team AS TEXT), ''), ''))) AS team
                    FROM octane_manual_runs mr
                    LEFT JOIN octane_run_traceability rt ON rt.run_id = mr.mr_id
                    WHERE {manual_where}
                      AND TRIM(COALESCE(CAST(mr.test_id AS TEXT), '')) <> ''
                      AND rt.run_id IS NULL
                    GROUP BY TRIM(COALESCE(CAST(mr.test_id AS TEXT), ''))
                    ORDER BY run_count DESC, test_id COLLATE NOCASE
                    LIMIT 20
                    """,
                    manual_params,
                ).fetchall()
            ]

        week_trace_where, week_trace_params = _build_trace_where(query_params, excluded_keys={"weeks"})
        week_plan_expression = _trace_plan_week_expression("rt")
        week_manual_expression = _manual_week_expression("mr")
        week_rows = conn.execute(
            f"""
            WITH scoped_rt AS (
                SELECT DISTINCT rt.run_id,
                       {week_plan_expression} AS plan_week
                FROM octane_run_traceability rt
                WHERE {week_trace_where}
            ), planned_weeks AS (
                SELECT DISTINCT run_id, plan_week AS value
                FROM scoped_rt
                WHERE plan_week <> ''
            ), runs_without_plan AS (
                SELECT DISTINCT scoped_rt.run_id
                FROM scoped_rt
                LEFT JOIN planned_weeks planned ON planned.run_id = scoped_rt.run_id
                WHERE planned.run_id IS NULL
            ), week_values AS (
                SELECT value FROM planned_weeks
                UNION
                SELECT DISTINCT {week_manual_expression} AS value
                FROM octane_manual_runs mr
                INNER JOIN runs_without_plan scoped_rt ON scoped_rt.run_id = mr.mr_id
                WHERE {week_manual_expression} <> ''
            )
            SELECT DISTINCT value
            FROM week_values
            WHERE value <> ''
            ORDER BY value COLLATE NOCASE
            """,
            week_trace_params,
        ).fetchall()

        filter_options = {
            "years": _distinct_values(conn, "octane_manual_runs", "year"),
            "teams": _distinct_values(conn, "octane_run_traceability", "scope_team"),
            "releases": _distinct_values(conn, "octane_run_traceability", "scope_release"),
            "weeks": [str(row["value"] or "") for row in week_rows],
            "statuses": _distinct_values(conn, "octane_manual_runs", "status"),
            "relation_types": _distinct_values(conn, "octane_run_traceability", "relation_type"),
        }
        return {
            "summary": summary,
            "filter_options": filter_options,
            "relation_type_rows": relation_type_rows,
            "status_rows": status_rows,
            "top_related_items": top_related_items,
            "traceability_chain_rows": traceability_chain_rows,
            "graph": _build_traceability_graph_from_relations(graph_relation_rows),
            "testcase_rows": testcase_rows,
            "gap_rows": gap_rows,
        }
    finally:
        conn.close()


def _distinct_values(conn: sqlite3.Connection, table_name: str, column_name: str) -> list[str]:
    if not _table_exists(conn, table_name):
        return []
    rows = conn.execute(
        f"""
        SELECT DISTINCT TRIM(COALESCE(CAST({column_name} AS TEXT), '')) AS value
        FROM {table_name}
        WHERE TRIM(COALESCE(CAST({column_name} AS TEXT), '')) <> ''
        ORDER BY value COLLATE NOCASE
        """
    ).fetchall()
    return [str(row["value"] or "") for row in rows]
