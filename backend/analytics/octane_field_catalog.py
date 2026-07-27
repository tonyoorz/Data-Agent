from __future__ import annotations

from collections.abc import Callable
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path


WORD_RE = re.compile(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]+")
DEFAULT_FIELD_CATALOG_PATH = Path(__file__).resolve().parents[2] / "ontology" / "generated" / "octane-field-catalog.local.json"
_CATALOG_CACHE: dict[str, Any] = {}

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "problem_finder_team": ("DTSV", "问题发现团队", "发现团队", "team", "owner team"),
    "model_series": ("车系", "车型", "model series", "lead model"),
    "software_version": ("软件版本", "software", "version", "i-step", "i step"),
    "creation_time": ("创建时间", "提 bug", "提交", "created", "opened"),
    "last_modified": ("更新时间", "最近更新", "modified"),
    "phase": ("阶段", "phase", "状态"),
    "severity": ("严重程度", "severity"),
    "priority": ("优先级", "priority"),
    "solution_cluster": ("问题模块", "solution cluster", "module"),
    "assigned_ecu": ("ECU", "模块", "assigned ecu"),
    "requirements": ("需求", "requirement", "aida"),
    "description": ("描述", "现象", "description"),
    "comments": ("评论", "comment", "沟通记录"),
    "finished": ("完成时间", "finished", "执行完成"),
    "status": ("状态", "status", "passed", "failed"),
}

BUCKET_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("identity", ("id", "name", "logical_name", "subtype")),
    ("lifecycle", ("phase", "status", "creation_time", "last_modified", "closed", "fixed", "sprint", "release")),
    ("ownership", ("team", "owner", "author", "detected_by", "finder", "responsible", "run_by")),
    ("product_vehicle", ("project", "program", "product", "ecu", "model", "software", "version", "platform", "i_step", "pu", "fv", "fvp")),
    ("requirement_traceability", ("requirement", "aida", "parent", "linked", "cover", "trace", "story", "feature")),
    ("quality_classification", ("severity", "priority", "class", "cluster", "category", "risk", "blocking", "error")),
    ("execution", ("run", "test", "finished", "started", "passed", "failed", "steps")),
    ("text_evidence", ("description", "comment", "memo", "attachment", "text")),
)


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _normalize_name(value: str) -> str:
    normalized = str(value or "").strip()
    if normalized.endswith("_udf"):
        normalized = normalized[:-4]
    return normalized


def _entity_from_table(table_name: str) -> str:
    raw = table_name.removeprefix("octane_")
    if raw == "defects":
        return "defect"
    if raw == "manual_runs":
        return "manual_run"
    if raw == "testcases":
        return "testcase"
    return raw.removesuffix("s")


def _tokens(*values: object) -> set[str]:
    tokens: set[str] = set()
    for value in values:
        for token in WORD_RE.findall(str(value or "").casefold()):
            tokens.add(token)
    return tokens


def _business_bucket(field_name: str) -> str:
    normalized = _normalize_name(field_name).casefold()
    for bucket, markers in BUCKET_RULES:
        if any(marker in normalized for marker in markers):
            return bucket
    return "system" if normalized in {"type", "workspace_id", "version_stamp", "raw_json", "year", "fetched_at"} else "other"


def _semantic_aliases(field_name: str) -> list[str]:
    normalized = _normalize_name(field_name).casefold()
    aliases: list[str] = []
    for marker, values in FIELD_ALIASES.items():
        if marker in normalized:
            aliases.extend(values)
    return sorted(dict.fromkeys(aliases))


def _value_kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "float"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        if "id" in value or "name" in value or "type" in value:
            return "reference"
        return "object"
    return "string"


def _is_populated(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def _column_populated_rows(conn: sqlite3.Connection, table_name: str, column_name: str) -> int:
    table = _quote_identifier(table_name)
    column = _quote_identifier(column_name)
    row = conn.execute(
        f"SELECT COUNT(*) FROM {table} WHERE {column} IS NOT NULL AND TRIM(CAST({column} AS TEXT)) != ''"
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _table_row_count(conn: sqlite3.Connection, table_name: str) -> int:
    row = conn.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}").fetchone()
    return int(row[0] or 0) if row else 0


def reset_octane_field_catalog_cache() -> None:
    _CATALOG_CACHE.clear()


def _cached_catalog(cache_key: tuple[object, ...], loader: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    if _CATALOG_CACHE.get("key") == cache_key and isinstance(_CATALOG_CACHE.get("catalog"), dict):
        return _CATALOG_CACHE["catalog"]
    catalog = loader()
    _CATALOG_CACHE["key"] = cache_key
    _CATALOG_CACHE["catalog"] = catalog
    return catalog


def _load_catalog_file(path: Path) -> dict[str, Any]:
    stat = path.stat()
    cache_key = ("file", str(path.resolve()), stat.st_mtime_ns, stat.st_size)
    return _cached_catalog(cache_key, lambda: json.loads(path.read_text(encoding="utf-8")))


def _build_cached_catalog(db_path: Path, sample_limit: int) -> dict[str, Any]:
    stat = db_path.stat() if db_path.exists() else None
    cache_key = (
        "db",
        str(db_path.resolve()),
        stat.st_mtime_ns if stat else None,
        stat.st_size if stat else None,
        int(sample_limit),
    )
    return _cached_catalog(cache_key, lambda: build_local_octane_field_catalog(db_path=db_path, sample_limit=sample_limit))


def load_local_octane_field_catalog(
    *,
    catalog_path: Path | str | None = None,
    db_path: Path | str | None = None,
    sample_limit: int = 2000,
    prefer_generated: bool = True,
) -> dict[str, Any]:
    configured_catalog_path = str(os.environ.get("VIZION_OCTANE_FIELD_CATALOG_PATH", "")).strip()
    resolved_catalog_path = Path(catalog_path or configured_catalog_path) if catalog_path or configured_catalog_path else None
    source_db_is_overridden = bool(
        str(os.environ.get("VIZION_FULL_PICTURE_SOURCE_DB_PATH", "")).strip()
        or str(os.environ.get("VIZION_DATABASE_ROOT", "")).strip()
    )
    if resolved_catalog_path is None and prefer_generated and db_path is None and not source_db_is_overridden and DEFAULT_FIELD_CATALOG_PATH.exists():
        resolved_catalog_path = DEFAULT_FIELD_CATALOG_PATH
    if resolved_catalog_path is not None and resolved_catalog_path.exists():
        return _load_catalog_file(resolved_catalog_path)

    resolved_db_path = Path(db_path) if db_path else get_full_picture_source_db_path()
    return _build_cached_catalog(resolved_db_path, sample_limit)


def _ontology_status(*, source: str, populated_rate: float, local_column: str | None, business_bucket: str) -> str:
    if populated_rate <= 0:
        return "raw"
    if local_column:
        return "mapped"
    if source == "table_column" and business_bucket not in {"system", "other"}:
        return "candidate"
    if populated_rate >= 0.2 and business_bucket not in {"system", "other"}:
        return "candidate"
    return "raw"


def _field_record(
    *,
    table_name: str,
    field_name: str,
    source: str,
    observed_rows: int,
    populated_rows: int,
    type_counts: Counter[str],
    columns: set[str],
) -> dict[str, Any]:
    normalized = _normalize_name(field_name)
    local_column = normalized if source == "raw_json" and normalized in columns else None
    populated_rate = round(populated_rows / observed_rows, 4) if observed_rows else 0.0
    bucket = _business_bucket(field_name)
    return {
        "id": f"{table_name}.{source}.{field_name}",
        "entity": _entity_from_table(table_name),
        "table": table_name,
        "field": field_name,
        "normalizedField": normalized,
        "source": source,
        "udf": field_name.endswith("_udf") or "_udf" in field_name,
        "localColumn": local_column,
        "businessBucket": bucket,
        "semanticAliases": _semantic_aliases(field_name),
        "observedRows": observed_rows,
        "populatedRows": populated_rows,
        "populatedRate": populated_rate,
        "valueKinds": dict(sorted(type_counts.items())),
        "ontologyStatus": _ontology_status(source=source, populated_rate=populated_rate, local_column=local_column, business_bucket=bucket),
    }


def _raw_json_field_records(conn: sqlite3.Connection, table_name: str, columns: set[str], sample_limit: int) -> list[dict[str, Any]]:
    if "raw_json" not in columns:
        return []
    stats: dict[str, dict[str, Any]] = defaultdict(lambda: {"populated": 0, "types": Counter()})
    observed_rows = 0
    rows = conn.execute(
        f"SELECT raw_json FROM {_quote_identifier(table_name)} WHERE raw_json IS NOT NULL AND raw_json != '' LIMIT ?",
        (int(sample_limit),),
    )
    for (raw_json,) in rows:
        try:
            payload = json.loads(raw_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        observed_rows += 1
        for key, value in payload.items():
            item = stats[str(key)]
            item["types"][_value_kind(value)] += 1
            if _is_populated(value):
                item["populated"] += 1
    return [
        _field_record(
            table_name=table_name,
            field_name=field_name,
            source="raw_json",
            observed_rows=observed_rows,
            populated_rows=int(item["populated"]),
            type_counts=item["types"],
            columns=columns,
        )
        for field_name, item in sorted(stats.items())
    ]


def _column_field_records(conn: sqlite3.Connection, table_name: str, columns: set[str], row_count: int) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for column_name in sorted(columns):
        populated_rows = _column_populated_rows(conn, table_name, column_name)
        records.append(
            _field_record(
                table_name=table_name,
                field_name=column_name,
                source="table_column",
                observed_rows=row_count,
                populated_rows=populated_rows,
                type_counts=Counter({"sqlite_column": populated_rows}),
                columns=columns,
            )
        )
    return records


def _ontology_draft(fields: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = []
    for field in fields:
        if field["ontologyStatus"] not in {"mapped", "candidate"}:
            continue
        if field["source"] == "table_column" and field["field"] == "raw_json":
            continue
        candidates.append(
            {
                "fieldId": field["id"],
                "entity": field["entity"],
                "field": field["field"],
                "normalizedField": field["normalizedField"],
                "businessBucket": field["businessBucket"],
                "recommendedStatus": "candidate",
                "reason": "mapped_local_column" if field["ontologyStatus"] == "mapped" else "business_field_with_observed_values",
            }
        )
    return {"fieldCandidates": candidates}


def build_local_octane_field_catalog(*, db_path: Path | str | None = None, sample_limit: int = 2000) -> dict[str, Any]:
    resolved_db_path = Path(db_path) if db_path else get_full_picture_source_db_path()
    conn = sqlite3.connect(resolved_db_path)
    try:
        table_names = [
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'octane_%' ORDER BY name")
        ]
        fields: list[dict[str, Any]] = []
        tables = []
        for table_name in table_names:
            columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table_name)})")}
            row_count = _table_row_count(conn, table_name)
            tables.append({"name": table_name, "entity": _entity_from_table(table_name), "columns": len(columns), "rows": row_count})
            fields.extend(_column_field_records(conn, table_name, columns, row_count))
            fields.extend(_raw_json_field_records(conn, table_name, columns, sample_limit))
    finally:
        conn.close()

    summary = {
        "tableCount": len(tables),
        "fieldCount": len(fields),
        "tableColumnCount": sum(1 for field in fields if field["source"] == "table_column"),
        "rawJsonFieldCount": sum(1 for field in fields if field["source"] == "raw_json"),
        "udfFieldCount": sum(1 for field in fields if field["udf"]),
        "mappedFieldCount": sum(1 for field in fields if field["ontologyStatus"] == "mapped"),
        "candidateFieldCount": sum(1 for field in fields if field["ontologyStatus"] == "candidate"),
    }
    return {
        "schemaVersion": "1.0",
        "catalogVersion": "local-sqlite-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"kind": "local_sqlite", "dbPath": str(resolved_db_path), "sampleLimit": int(sample_limit)},
        "summary": summary,
        "tables": tables,
        "fields": fields,
        "ontologyDraft": _ontology_draft(fields),
    }


def _retrieval_text(field: dict[str, Any]) -> str:
    return " ".join(
        str(part)
        for part in [
            field.get("id"),
            field.get("entity"),
            field.get("field"),
            field.get("normalizedField"),
            field.get("businessBucket"),
            " ".join(field.get("semanticAliases") or []),
        ]
        if part
    )


def search_octane_fields(catalog: dict[str, Any], query: str, *, entity: str | None = None, top_k: int = 20) -> list[dict[str, Any]]:
    query_tokens = _tokens(query)
    if not query_tokens:
        return []
    normalized_entity = str(entity or "").strip()
    scored: list[dict[str, Any]] = []
    for field in catalog.get("fields", []):
        if normalized_entity and field.get("entity") != normalized_entity:
            continue
        field_tokens = _tokens(_retrieval_text(field))
        overlap = query_tokens & field_tokens
        alias_tokens = _tokens(" ".join(field.get("semanticAliases") or []))
        score = len(overlap) * 2 + len(query_tokens & alias_tokens) * 3
        if field.get("ontologyStatus") == "mapped":
            score += 2
        if field.get("businessBucket") not in {"system", "other"}:
            score += 1
        if score <= 0:
            continue
        result = {key: field[key] for key in ("id", "entity", "table", "field", "source", "localColumn", "businessBucket", "ontologyStatus")}
        result["score"] = score
        result["matchedTokens"] = sorted(overlap)
        scored.append(result)
    scored.sort(key=lambda item: (-int(item["score"]), item["id"]))
    return scored[: max(1, int(top_k or 20))]