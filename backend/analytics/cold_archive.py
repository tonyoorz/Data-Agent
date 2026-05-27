from __future__ import annotations

from pathlib import Path
import sqlite3

import pandas as pd


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
	conn = sqlite3.connect(str(source_db_path))
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
	resolved_cold_db_path.touch(exist_ok=True)

	duckdb = _import_duckdb()
	duck_conn = duckdb.connect(str(resolved_cold_db_path))
	table_summaries: list[dict[str, object]] = []
	try:
		with sqlite3.connect(str(resolved_source_path)) as sqlite_conn:
			for index, table_name in enumerate(_list_sqlite_tables(resolved_source_path), start=1):
				frame = pd.read_sql_query(
					f"SELECT * FROM {_quote_identifier(table_name)}",
					sqlite_conn,
				)
				relation_name = f"archive_frame_{index}"
				duck_conn.register(relation_name, frame)
				duck_conn.execute(
					f"CREATE OR REPLACE TABLE {_quote_identifier(table_name)} AS SELECT * FROM {relation_name}"
				)
				parquet_path = (resolved_parquet_dir / f"{table_name}.parquet").resolve()
				duck_conn.execute(
					f"COPY {_quote_identifier(table_name)} TO {_quote_sql_string(parquet_path)} (FORMAT PARQUET)"
				)
				if hasattr(duck_conn, "unregister"):
					try:
						duck_conn.unregister(relation_name)
					except Exception:
						pass
				table_summaries.append(
					{
						"table_name": table_name,
						"row_count": len(frame),
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