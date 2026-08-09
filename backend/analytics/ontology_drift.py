"""SchemaDriftDetector — compares ontology-defined properties vs actual SQLite columns."""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ColumnDrift:
    """A single column-level mismatch between ontology and database."""

    entity_id: str
    table: str
    column_name: str
    drift_type: str  # "unmapped" (in DB not ontology) or "missing" (in ontology not DB)
    suggested_property: str | None = None  # suggested ontology property id


@dataclass
class DriftReport:
    """Aggregated drift across all checked entities."""

    total_entities_checked: int = 0
    drifts: list[ColumnDrift] = field(default_factory=list)

    @property
    def has_drift(self) -> bool:
        return len(self.drifts) > 0


@dataclass
class MappingSuggestion:
    """Suggested ontology property mapping for an unmapped DB column."""

    column_name: str
    suggested_property_id: str
    confidence: float  # 0-1, based on name similarity


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _levenshtein(a: str, b: str) -> int:
    """Classic Levenshtein distance (iterative, O(n*m))."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(
                prev[j] + 1,          # deletion
                curr[j - 1] + 1,      # insertion
                prev[j - 1] + (ca != cb),  # substitution
            ))
        prev = curr
    return prev[-1]


def _name_similarity(a: str, b: str) -> float:
    """Normalised similarity in [0, 1] from Levenshtein distance."""
    a_lower, b_lower = a.lower(), b.lower()
    max_len = max(len(a_lower), len(b_lower))
    if max_len == 0:
        return 0.0
    return 1.0 - (_levenshtein(a_lower, b_lower) / max_len)


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------


class SchemaDriftDetector:
    """Compare each entity's defined properties vs actual DB columns."""

    def __init__(
        self,
        catalog: OntologyCatalog | None = None,
        db_path: Path | None = None,
    ) -> None:
        self._catalog = catalog or load_ontology()
        self._db_path = db_path or get_full_picture_source_db_path()

    # -- internal helpers ---------------------------------------------------

    def _get_table_columns(self, conn: sqlite3.Connection, table: str) -> set[str]:
        """Return the set of column names for *table* in *conn*."""
        try:
            cursor = conn.execute(f"PRAGMA table_info({table})")
            return {row[1] for row in cursor.fetchall()}
        except sqlite3.OperationalError:
            return set()

    def _get_entity_table(self, entity: dict[str, Any]) -> str | None:
        """Extract table name from entity.source.table or entity.source.readModel."""
        source = entity.get("source") or {}
        return source.get("table") or source.get("readModel")

    def _get_ontology_columns(self, entity: dict[str, Any]) -> set[str]:
        """Return the set of property ids declared on *entity*."""
        return {p["id"] for p in entity.get("properties", []) if "id" in p}

    def _all_property_ids(self) -> list[str]:
        """Flat list of all property ids across every entity (for suggestions)."""
        result: list[str] = []
        for entity in self._catalog.bundle.get("entities", []):
            for prop in entity.get("properties", []):
                if "id" in prop:
                    result.append(prop["id"])
        return result

    # -- public API ---------------------------------------------------------

    def detect_drift(self) -> DriftReport:
        """Compare each entity's properties vs actual DB columns."""
        report = DriftReport()
        entities = self._catalog.bundle.get("entities", [])

        # Connect once if possible; otherwise each table check will return empty.
        conn: sqlite3.Connection | None = None
        if self._db_path and self._db_path.is_file():
            conn = sqlite3.connect(str(self._db_path))

        try:
            for entity in entities:
                eid = entity.get("id", "")
                table = self._get_entity_table(entity)
                report.total_entities_checked += 1

                if table is None:
                    continue

                if conn is None:
                    # No DB available — every ontology column is "missing"
                    ontology_cols = self._get_ontology_columns(entity)
                    for col in sorted(ontology_cols):
                        report.drifts.append(ColumnDrift(
                            entity_id=eid,
                            table=table,
                            column_name=col,
                            drift_type="missing",
                        ))
                    continue

                db_cols = self._get_table_columns(conn, table)
                if not db_cols:
                    # Table doesn't exist in DB
                    report.drifts.append(ColumnDrift(
                        entity_id=eid,
                        table=table,
                        column_name="__table__",
                        drift_type="missing",
                    ))
                    continue

                ontology_cols = self._get_ontology_columns(entity)

                # Unmapped: in DB but not in ontology
                for col in sorted(db_cols - ontology_cols):
                    report.drifts.append(ColumnDrift(
                        entity_id=eid,
                        table=table,
                        column_name=col,
                        drift_type="unmapped",
                    ))

                # Missing: in ontology but not in DB
                for col in sorted(ontology_cols - db_cols):
                    report.drifts.append(ColumnDrift(
                        entity_id=eid,
                        table=table,
                        column_name=col,
                        drift_type="missing",
                    ))
        finally:
            if conn is not None:
                conn.close()

        return report

    def suggest_mappings(self, drift: DriftReport) -> list[MappingSuggestion]:
        """For unmapped columns, find the closest ontology property by similarity."""
        all_props = self._all_property_ids()
        suggestions: list[MappingSuggestion] = []

        for d in drift.drifts:
            if d.drift_type != "unmapped":
                continue
            best_prop: str | None = None
            best_score = 0.0
            for prop_id in all_props:
                score = _name_similarity(d.column_name, prop_id)
                if score > best_score:
                    best_score = score
                    best_prop = prop_id
            if best_prop is not None and best_score > 0:
                suggestions.append(MappingSuggestion(
                    column_name=d.column_name,
                    suggested_property_id=best_prop,
                    confidence=round(best_score, 4),
                ))

        return suggestions
