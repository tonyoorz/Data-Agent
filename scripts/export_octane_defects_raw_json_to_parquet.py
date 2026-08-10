"""Parse ``octane_defects.raw_json`` into flat columns and archive to cold parquet.

The source ``octane_defects`` table (``database/source/qgate_raw.db``) stores the full
Octane defect entity as a JSON blob in ``raw_json``.  The sibling flattened columns are
a pre-extracted subset that drops entity ids and collection members.  This script parses
``raw_json`` for every row and writes the complete, query-ready picture to cold storage:

* ``database/cold/parquet/octane_defects_parsed.parquet``  — one row per defect
* ``database/cold/qgate_archive.duckdb`` table ``octane_defects_parsed`` — same data registered in DuckDB

Each top-level Octane key becomes one or more columns:

* scalar (str/int/float/bool) -> ``<key>`` as-is
* entity reference (dict with id/name/type) -> ``<key>`` (name) + ``<key>_id`` + ``<key>_type``
* collection (``{"total_count", "data": [...]}`` or a bare list) -> ``<key>`` (``;``-joined names) + ``<key>_count``

``defect_id`` and ``fetched_at`` are carried over from the source table so each row stays
identifiable and refresh-stamped; the original ``raw_json`` text is kept as ``raw_json`` for
anything not flattened.  Unknown keys discovered while scanning are included too, so the
output is forward-compatible with Octane schema additions.

Run with the project venv (has duckdb)::

    .venv/Scripts/python scripts/export_octane_defects_raw_json_to_parquet.py
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd

# Mirrors backend.analytics.config defaults so the script works standalone.
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DB = REPO_ROOT / "database" / "source" / "qgate_raw.db"
DEFAULT_COLD_DB = REPO_ROOT / "database" / "cold" / "qgate_archive.duckdb"
DEFAULT_PARQUET_DIR = REPO_ROOT / "database" / "cold" / "parquet"
PARQUET_NAME = "octane_defects_parsed.parquet"
TABLE_NAME = "octane_defects_parsed"
CHUNK_SIZE = 5_000

# Keys whose value is metadata about the fetch/payload, not a defect attribute.
# They are intentionally excluded from the flattened output (raw_json keeps everything).
META_KEYS = {"type", "workspace_id"}


def _import_duckdb():
    try:
        import duckdb
    except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "duckdb is required; run this script with the project venv "
            "('.venv/Scripts/python') which has duckdb installed."
        ) from exc
    return duckdb


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _scalar(value: Any) -> Any:
    """Return JSON scalars unchanged; coerce bool to int for parquet friendliness."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)) or value is None:
        return value
    return None


def _entity_cols(value: dict) -> tuple[str | None, str | None, str | None]:
    """Extract (name, id, type) from an Octane entity-reference dict."""
    return (
        value.get("name") if isinstance(value.get("name"), str) else None,
        str(value.get("id")) if value.get("id") is not None else None,
        value.get("type") if isinstance(value.get("type"), str) else None,
    )


def _collection_members(value: Any) -> list[str]:
    """Return the list of member dicts/strings from a collection-ish value."""
    data: Any = value
    if isinstance(value, dict) and "data" in value:
        data = value.get("data")
    if not isinstance(data, list):
        return []
    members: list[str] = []
    for item in data:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str) and name:
                members.append(name)
            elif item.get("id") is not None:
                members.append(str(item["id"]))
        elif isinstance(item, str) and item:
            members.append(item)
    return members


def _is_collection(value: Any) -> bool:
    if isinstance(value, dict):
        return "total_count" in value and "data" in value
    return isinstance(value, list)


def _is_entity_ref(value: Any) -> bool:
    return isinstance(value, dict) and ("id" in value or "name" in value or "type" in value) and not _is_collection(value)


def _classify_key(key: str, value: Any) -> str:
    """Map a top-level JSON value to a flattening strategy.

    Returns one of: collection | entity | scalar_int | scalar_float | scalar_str.
    Scalars carry their JSON type so they can map to a precise DuckDB column type
    (avoids ints being widened to doubles and rendered as ``2025.0``).
    """
    if _is_collection(value):
        return "collection"
    if _is_entity_ref(value):
        return "entity"
    if isinstance(value, bool):
        return "scalar_int"
    if isinstance(value, int):
        return "scalar_int"
    if isinstance(value, float):
        return "scalar_float"
    return "scalar_str"


_SCALAR_STRATEGIES = {"scalar_int", "scalar_float", "scalar_str"}


def _scalar_strategy(value: Any) -> str | None:
    """Classify a non-null scalar value, or None if it is not a scalar."""
    if value is None or isinstance(value, (dict, list)):
        return None
    return _classify_key("", value)


def _collect_key_plan(conn: sqlite3.Connection) -> dict[str, str]:
    """Scan every row's raw_json once to build a stable {key: strategy} plan.

    A key's strategy is decided by the first non-null value observed; if a later row
    shows a richer shape (e.g. a key seen as null then as an entity), the strategy is
    upgraded.  Scalars settle on their own int/float/str subtype but are upgraded if a
    structured value is later seen.  Returns keys in insertion order for stable columns.
    """
    plan: dict[str, str] = {}
    rows = conn.execute(
        "SELECT raw_json FROM octane_defects WHERE raw_json IS NOT NULL AND raw_json != ''"
    )
    for (raw,) in rows:
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        for key, value in payload.items():
            if key in META_KEYS:
                if key not in plan:
                    plan[key] = "skip"
                continue
            strat = _classify_key(key, value)
            current = plan.get(key)
            # Null-ish (None) values are classified as scalar_str by _classify_key, but they
            # must not settle the plan before a real value is seen for numeric keys.
            if value is None:
                if current is None:
                    plan[key] = "scalar_str"  # provisional; upgraded when a real value appears
                continue
            if strat in _SCALAR_STRATEGIES:
                # First real value settles the scalar subtype; a later int on a float key keeps
                # float (widening), a later float on an int key upgrades to float.
                if current is None or current == "scalar_str":
                    plan[key] = strat
                elif current == "scalar_int" and strat == "scalar_float":
                    plan[key] = "scalar_float"
                continue
            # entity / collection upgrade any scalar baseline (and are terminal vs each other
            # only when the richer shape wins).
            if current is None or current in _SCALAR_STRATEGIES:
                plan[key] = strat
            elif current == "entity" and strat == "collection":
                plan[key] = "collection"
            elif current == "collection" and strat == "entity":
                plan[key] = "collection"
    return plan


def _column_specs(plan: dict[str, str]) -> list[tuple[str, str]]:
    """Produce (column_name, duckdb_type) pairs in stable order."""
    cols: list[tuple[str, str]] = [
        ("defect_id", "VARCHAR"),
        ("fetched_at", "VARCHAR"),
    ]
    for key, strategy in plan.items():
        if strategy == "skip":
            continue
        if strategy == "entity":
            cols.append((key, "VARCHAR"))
            cols.append((f"{key}_id", "VARCHAR"))
            cols.append((f"{key}_type", "VARCHAR"))
        elif strategy == "collection":
            cols.append((key, "VARCHAR"))
            cols.append((f"{key}_count", "INTEGER"))
        elif strategy == "scalar_int":
            cols.append((key, "BIGINT"))
        elif strategy == "scalar_float":
            cols.append((key, "DOUBLE"))
        else:  # scalar_str (including provisional None-settled keys)
            cols.append((key, "VARCHAR"))
    cols.append(("raw_json", "VARCHAR"))
    return cols


def _flatten_row(defect_id: str, fetched_at: str | None, raw_json: str, plan: dict[str, str]) -> dict[str, Any]:
    row: dict[str, Any] = {"defect_id": defect_id, "fetched_at": fetched_at}
    try:
        payload = json.loads(raw_json) if raw_json else None
    except (TypeError, json.JSONDecodeError):
        payload = None
    if not isinstance(payload, dict):
        payload = {}
    for key, strategy in plan.items():
        if strategy == "skip":
            continue
        value = payload.get(key)
        if strategy == "entity":
            name, eid, etype = _entity_cols(value) if isinstance(value, dict) else (None, None, None)
            row[key] = name
            row[f"{key}_id"] = eid
            row[f"{key}_type"] = etype
        elif strategy == "collection":
            members = _collection_members(value) if value is not None else []
            row[key] = "; ".join(members) if members else None
            row[f"{key}_count"] = len(members)
        else:  # scalar
            row[key] = _scalar(value)
    row["raw_json"] = raw_json
    return row


def _row_tuple(row: dict[str, Any], columns: list[str]) -> tuple:
    return tuple(row.get(c) for c in columns)


def _frame_from_rows(rows: list[dict[str, Any]], columns: list[str]) -> "pd.DataFrame":
    """Build a DataFrame with a fixed column order so DuckDB inserts align exactly."""
    # object dtype keeps mixed scalars (str/int/None) lossless across chunks.
    return pd.DataFrame(rows, columns=columns).astype(object)


def export(
    source_db: Path = DEFAULT_SOURCE_DB,
    cold_db: Path = DEFAULT_COLD_DB,
    parquet_dir: Path = DEFAULT_PARQUET_DIR,
    *,
    overwrite: bool = True,
) -> dict[str, object]:
    """Parse raw_json from every octane_defects row and archive to parquet + duckdb."""
    if not source_db.exists():
        raise FileNotFoundError(f"source db not found: {source_db}")

    parquet_dir.mkdir(parents=True, exist_ok=True)
    cold_db.parent.mkdir(parents=True, exist_ok=True)
    parquet_path = parquet_dir / PARQUET_NAME

    duckdb = _import_duckdb()

    sqlite_conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        total = sqlite_conn.execute(
            "SELECT COUNT(*) FROM octane_defects WHERE raw_json IS NOT NULL AND raw_json != ''"
        ).fetchone()[0]
        print(f"[scan] {total:,} rows with raw_json in {source_db.name}")

        plan = _collect_key_plan(sqlite_conn)
        scalar_n = sum(1 for s in plan.values() if s in _SCALAR_STRATEGIES)
        entity_n = sum(1 for s in plan.values() if s == "entity")
        coll_n = sum(1 for s in plan.values() if s == "collection")
        skip_n = sum(1 for s in plan.values() if s == "skip")
        print(
            f"[plan] {len(plan)} top-level keys: "
            f"{scalar_n} scalar, {entity_n} entity-ref, {coll_n} collection, {skip_n} skipped"
        )

        col_specs = _column_specs(plan)
        columns = [name for name, _ in col_specs]
        col_defs = ", ".join(f"{_quote_ident(name)} {dtype}" for name, dtype in col_specs)
        print(f"[plan] {len(columns)} output columns")

        duck_conn = duckdb.connect(str(cold_db))
        try:
            if overwrite:
                duck_conn.execute(f"DROP TABLE IF EXISTS {_quote_ident(TABLE_NAME)}")
            duck_conn.execute(f"CREATE TABLE {_quote_ident(TABLE_NAME)} ({col_defs})")

            cur = sqlite_conn.execute(
                "SELECT defect_id, fetched_at, raw_json FROM octane_defects "
                "WHERE raw_json IS NOT NULL AND raw_json != ''"
            )
            written = 0
            while True:
                batch = cur.fetchmany(CHUNK_SIZE)
                if not batch:
                    break
                rows = [
                    _flatten_row(did, fat, rj, plan)
                    for did, fat, rj in batch
                ]
                frame = _frame_from_rows(rows, columns)
                rel = f"batch_{written // CHUNK_SIZE}"
                duck_conn.register(rel, frame)
                try:
                    duck_conn.execute(
                        f"INSERT INTO {_quote_ident(TABLE_NAME)} SELECT * FROM {rel}"
                    )
                finally:
                    try:
                        duck_conn.unregister(rel)
                    except Exception:
                        pass
                written += len(batch)
                if written % (CHUNK_SIZE * 10) == 0 or written == total:
                    print(f"[write] {written:,}/{total:,} rows")

            duck_conn.execute(
                f"COPY {_quote_ident(TABLE_NAME)} TO '{parquet_path.as_posix()}' (FORMAT PARQUET)"
            )
        finally:
            duck_conn.close()
    finally:
        sqlite_conn.close()

    size_mb = parquet_path.stat().st_size / (1024 * 1024)
    print(f"[done] parquet -> {parquet_path} ({size_mb:,.1f} MB)")
    print(f"[done] duckdb  -> {cold_db} (table: {TABLE_NAME})")
    return {
        "source_db": str(source_db),
        "cold_db": str(cold_db),
        "parquet_path": str(parquet_path),
        "row_count": total,
        "column_count": len(columns),
        "columns": columns,
    }


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-db", type=Path, default=DEFAULT_SOURCE_DB)
    p.add_argument("--cold-db", type=Path, default=DEFAULT_COLD_DB)
    p.add_argument("--parquet-dir", type=Path, default=DEFAULT_PARQUET_DIR)
    p.add_argument("--no-overwrite", action="store_true", help="Do not drop existing table")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    summary = export(
        source_db=args.source_db,
        cold_db=args.cold_db,
        parquet_dir=args.parquet_dir,
        overwrite=not args.no_overwrite,
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
