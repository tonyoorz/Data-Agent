from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.ingest.source_store import OctaneSourceStore


DEFAULT_LIGHT_HISTORY_FIELDS = frozenset(
    {
        "phase",
        "severity",
        "problem_severity",
        "owner",
        "status",
        "status_phase",
    }
)

HISTORY_COMMIT_INTERVAL = 50


def default_db_path(repo_root: str | None = None) -> str:
    return str(get_full_picture_source_db_path())


class OctaneSQLiteStore:
    def __init__(self, db_path: str, sync_history_events: bool = True):
        self.db_path = str(db_path)
        self.sync_history_events = bool(sync_history_events)
        self._payload_cache: dict[tuple[str, str, int | None, str], Any] = {}
        self._source_store: OctaneSourceStore | None = None
        self._pending_history_writes = 0

    def close(self) -> None:
        if self._source_store is None:
            return None
        if self._pending_history_writes:
            self._source_store.commit()
            self._pending_history_writes = 0
        self._source_store.close()
        self._source_store = None
        return None

    def _store(self) -> OctaneSourceStore:
        if self._source_store is None:
            self._source_store = OctaneSourceStore(self.db_path)
        return self._source_store

    def create_tables(self) -> None:
        self._store().create_tables()

    def create_optimized_tables(self) -> None:
        self.create_tables()

    def upsert_payload(
        self,
        *,
        kind: str,
        team: str,
        year: int | None,
        spec: str,
        payload: Any,
        fetched_at: str | None = None,
        commit: bool = True,
    ) -> None:
        self._payload_cache[(str(kind), str(team), year, str(spec))] = payload

    def upsert_defects_batch(self, defects: list[dict[str, Any]], year: int, fetched_at: str | None = None) -> int:
        prepared: list[dict[str, Any]] = []
        for defect in defects or []:
            if not isinstance(defect, dict):
                continue
            row = dict(defect)
            product_areas = row.get("product_areas")
            if isinstance(product_areas, dict) and isinstance(product_areas.get("data"), list):
                row["product_areas"] = list(product_areas.get("data") or [])
            row.setdefault("year", year)
            prepared.append(row)

        store = self._store()
        store.create_tables()
        return store.upsert_defects(prepared, team="", year=year)

    def upsert_defect_history(
        self,
        *,
        defect_id: str,
        team: str,
        payload: Any,
        total_count: int | None = None,
        fetched_at: str | None = None,
        commit: bool = True,
    ) -> int:
        normalized_payload = payload if isinstance(payload, dict) else {"data": list(payload or [])}
        store = self._store()
        store.create_tables()
        inserted_rows = store.replace_defect_history_events(
            defect_id=str(defect_id),
            payload=normalized_payload,
            team=str(team or ""),
            commit=False,
        )
        self._pending_history_writes += 1
        if self._pending_history_writes >= HISTORY_COMMIT_INTERVAL:
            store.commit()
            self._pending_history_writes = 0
        return inserted_rows

    def upsert_manual_runs_batch(
        self,
        manual_runs: list[dict[str, Any]],
        year: int,
        spec: str,
        fetched_at: str | None = None,
    ) -> int:
        prepared: list[dict[str, Any]] = []
        for run in manual_runs or []:
            if not isinstance(run, dict):
                continue
            row = dict(run)
            product_areas = row.get("product_areas")
            if isinstance(product_areas, dict) and isinstance(product_areas.get("data"), list):
                row["product_areas"] = list(product_areas.get("data") or [])
            row.setdefault("year", year)
            prepared.append(row)

        store = self._store()
        store.create_tables()
        return store.upsert_manual_runs(prepared, team="", year=year, spec=spec)

    def upsert_testcase_dataset(self, dataset: dict[str, Any], fetched_at: str | None = None) -> dict[str, int]:
        self.create_tables()

        scope = dataset.get("scope") if isinstance(dataset, dict) else {}
        scope_team = str(scope.get("team") or "UNKNOWN")
        scope_release = str(scope.get("release") or "ALL")
        source = str(scope.get("source") or "runs")
        fetched_value = str(fetched_at or dataset.get("generated_at") or "")
        testcases = dataset.get("testcases") if isinstance(dataset, dict) else []

        testcase_rows: list[tuple[object, ...]] = []
        relation_rows: list[tuple[object, ...]] = []
        for testcase in testcases or []:
            if not isinstance(testcase, dict):
                continue
            test_id = str(testcase.get("test_id") or "").strip()
            if not test_id:
                continue

            testcase_rows.append(
                (
                    test_id,
                    scope_team,
                    scope_release,
                    source,
                    str(testcase.get("test_name") or "").strip(),
                    str(testcase.get("test_subtype") or "").strip(),
                    int(testcase.get("run_count") or len(list(testcase.get("run_ids") or [])) or 0),
                    json.dumps(list(testcase.get("run_ids") or []), ensure_ascii=False),
                    json.dumps(dict(testcase.get("run_status_distribution") or {}), ensure_ascii=False),
                    json.dumps(list(testcase.get("defect_ids") or []), ensure_ascii=False),
                    json.dumps(list(testcase.get("manual_test_ids") or []), ensure_ascii=False),
                    json.dumps(list(testcase.get("feature_ids") or []), ensure_ascii=False),
                    json.dumps(list(testcase.get("story_ids") or []), ensure_ascii=False),
                    json.dumps(testcase, ensure_ascii=False),
                    fetched_value,
                )
            )

            relation_sources = (
                ("defect", testcase.get("defect_links") or []),
                ("manual_test", testcase.get("manual_test_links") or []),
                ("feature", testcase.get("feature_links") or []),
                ("story", testcase.get("story_links") or []),
            )
            for relation_type, relations in relation_sources:
                for relation in relations:
                    if not isinstance(relation, dict):
                        continue
                    related_id = str(relation.get("id") or "").strip()
                    if not related_id:
                        continue
                    relation_rows.append(
                        (
                            test_id,
                            scope_team,
                            scope_release,
                            source,
                            relation_type,
                            related_id,
                            str(relation.get("name") or "").strip(),
                            str(relation.get("subtype") or relation_type).strip(),
                            str(relation.get("path") or "").strip(),
                            fetched_value,
                        )
                    )

        conn = sqlite3.connect(self.db_path)
        try:
            if testcase_rows:
                conn.executemany(
                    """
                    INSERT INTO octane_testcases(
                        test_id, scope_team, scope_release, source, test_name, test_subtype,
                        run_count, run_ids_json, run_status_distribution_json, defect_ids_json,
                        manual_test_ids_json, feature_ids_json, story_ids_json, raw_json, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(test_id, scope_team, scope_release, source) DO UPDATE SET
                        test_name=excluded.test_name,
                        test_subtype=excluded.test_subtype,
                        run_count=excluded.run_count,
                        run_ids_json=excluded.run_ids_json,
                        run_status_distribution_json=excluded.run_status_distribution_json,
                        defect_ids_json=excluded.defect_ids_json,
                        manual_test_ids_json=excluded.manual_test_ids_json,
                        feature_ids_json=excluded.feature_ids_json,
                        story_ids_json=excluded.story_ids_json,
                        raw_json=excluded.raw_json,
                        fetched_at=excluded.fetched_at
                    """,
                    testcase_rows,
                )
            if relation_rows:
                conn.executemany(
                    """
                    INSERT INTO octane_testcase_relations(
                        test_id, scope_team, scope_release, source, relation_type,
                        related_id, related_name, related_subtype, related_path, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(test_id, scope_team, scope_release, source, relation_type, related_id) DO UPDATE SET
                        related_name=excluded.related_name,
                        related_subtype=excluded.related_subtype,
                        related_path=excluded.related_path,
                        fetched_at=excluded.fetched_at
                    """,
                    relation_rows,
                )
            conn.commit()
        finally:
            conn.close()

        return {"testcases": len(testcase_rows), "relations": len(relation_rows)}