from __future__ import annotations

from pathlib import Path
import sqlite3
from backend.analytics.db import ensure_wal_pragmas

import pandas as pd


SQLITE_EXPORT_CHUNK_SIZE = 1_000


def _import_duckdb():
	try:
		import duckdb
	except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
		raise RuntimeError(
			"duckdb is required for cold archive export; install requirements.txt first"
		) from exc
	return duckdb


def _quote_identifier(identifier: str) -> str:
	return '"' + str(identifier).replace('"', '""') + '"'


def _quote_sql_string(value: Path | str) -> str:
	return "'" + str(value).replace("'", "''") + "'"


def _list_sqlite_tables(source_db_path: Path) -> list[str]:
	conn = ensure_wal_pragmas(sqlite3.connect(str(source_db_path)))
	try:
		rows = conn.execute(
			"""
			SELECT name
			FROM sqlite_master
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name
			"""
		).fetchall()
	finally:
		conn.close()
	return [str(row[0]).strip() for row in rows if str(row[0]).strip()]


def _sqlite_table_query(table_name: str) -> str:
	return f"SELECT * FROM {_quote_identifier(table_name)}"


def _sqlite_columns(sqlite_conn: sqlite3.Connection, table_name: str) -> list[tuple[str, str]]:
	rows = sqlite_conn.execute(
		f"PRAGMA table_info({_quote_identifier(table_name)})"
	).fetchall()
	return [
		(str(row[1]).strip(), str(row[2] or "").strip())
		for row in rows
		if str(row[1]).strip()
	]


def _sqlite_type_to_duckdb(sqlite_type: str) -> str:
	normalized = sqlite_type.strip().upper()
	if not normalized:
		return "VARCHAR"
	if "INT" in normalized:
		return "BIGINT"
	if any(token in normalized for token in ("CHAR", "CLOB", "TEXT")):
		return "VARCHAR"
	if "BLOB" in normalized:
		return "BLOB"
	if any(token in normalized for token in ("REAL", "FLOA", "DOUB")):
		return "DOUBLE"
	if any(token in normalized for token in ("DECIMAL", "NUMERIC")):
		return "DOUBLE"
	if "BOOL" in normalized:
		return "BOOLEAN"
	if any(token in normalized for token in ("DATE", "TIME")):
		return "TIMESTAMP"
	return "VARCHAR"


def _create_duckdb_table_from_sqlite_schema(duck_conn, sqlite_conn: sqlite3.Connection, table_name: str) -> None:
	columns = _sqlite_columns(sqlite_conn, table_name)
	if not columns:
		raise RuntimeError(f"SQLite table {table_name!r} has no columns")
	column_sql = ", ".join(
		f"{_quote_identifier(column_name)} {_sqlite_type_to_duckdb(column_type)}"
		for column_name, column_type in columns
	)
	duck_conn.execute(
		f"CREATE OR REPLACE TABLE {_quote_identifier(table_name)} ({column_sql})"
	)


def _copy_sqlite_table_to_duckdb(duck_conn, sqlite_conn: sqlite3.Connection, table_name: str, table_index: int) -> int:
	row_count = 0
	query = _sqlite_table_query(table_name)
	_create_duckdb_table_from_sqlite_schema(duck_conn, sqlite_conn, table_name)
	for chunk_index, frame in enumerate(
		pd.read_sql_query(query, sqlite_conn, chunksize=SQLITE_EXPORT_CHUNK_SIZE),
		start=1,
	):
		relation_name = f"archive_frame_{table_index}_{chunk_index}"
		duck_conn.register(relation_name, frame)
		try:
			duck_conn.execute(
				f"INSERT INTO {_quote_identifier(table_name)} SELECT * FROM {relation_name}"
			)
		finally:
			if hasattr(duck_conn, "unregister"):
				try:
					duck_conn.unregister(relation_name)
				except Exception:
					pass
		row_count += len(frame)

	return row_count


def archive_source_to_cold_storage(
	source_db_path: Path | str,
	cold_db_path: Path | str,
	parquet_dir: Path | str,
) -> dict[str, object]:
	resolved_source_path = Path(source_db_path).resolve()
	if not resolved_source_path.exists():
		raise FileNotFoundError(resolved_source_path)

	resolved_cold_db_path = Path(cold_db_path).resolve()
	resolved_parquet_dir = Path(parquet_dir).resolve()
	resolved_cold_db_path.parent.mkdir(parents=True, exist_ok=True)
	resolved_parquet_dir.mkdir(parents=True, exist_ok=True)
	if resolved_cold_db_path.exists() and resolved_cold_db_path.stat().st_size == 0:
		resolved_cold_db_path.unlink()

	duckdb = _import_duckdb()
	duck_conn = duckdb.connect(str(resolved_cold_db_path))
	table_summaries: list[dict[str, object]] = []
	try:
		with ensure_wal_pragmas(sqlite3.connect(str(resolved_source_path))) as sqlite_conn:
			for index, table_name in enumerate(_list_sqlite_tables(resolved_source_path), start=1):
				row_count = _copy_sqlite_table_to_duckdb(duck_conn, sqlite_conn, table_name, index)
				parquet_path = (resolved_parquet_dir / f"{table_name}.parquet").resolve()
				duck_conn.execute(
					f"COPY {_quote_identifier(table_name)} TO {_quote_sql_string(parquet_path)} (FORMAT PARQUET)"
				)
				table_summaries.append(
					{
						"table_name": table_name,
						"row_count": row_count,
						"parquet_path": str(parquet_path),
					}
				)
	finally:
		duck_conn.close()

	return {
		"source_db_path": str(resolved_source_path),
		"cold_db_path": str(resolved_cold_db_path),
		"parquet_dir": str(resolved_parquet_dir),
		"table_count": len(table_summaries),
		"tables": table_summaries,
	}