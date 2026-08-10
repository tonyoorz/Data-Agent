"""Tests for SchemaDriftDetector — compares ontology properties vs actual DB columns."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from backend.analytics.ontology import OntologyCatalog, ontology_fingerprint
from backend.analytics.ontology_drift import (
    ColumnDrift,
    DriftReport,
    MappingSuggestion,
    SchemaDriftDetector,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MINIMAL_BUNDLE = {
    "schemaVersion": "1.0",
    "ontologyVersion": "v1",
    "entities": [
        {
            "id": "quality.defect",
            "source": {"table": "defects", "readModel": "defects"},
            "properties": [
                {"id": "defect_id", "type": "string"},
                {"id": "severity", "type": "string"},
                {"id": "status", "type": "string"},
            ],
        },
        {
            "id": "organization.team",
            "source": {"table": "teams", "readModel": "teams"},
            "properties": [
                {"id": "team_id", "type": "string"},
                {"id": "team_name", "type": "string"},
            ],
        },
    ],
    "metrics": [],
    "dimensions": [],
    "terms": [],
    "policies": [],
    "constraints": [],
    "actions": [],
    "relationships": [],
    "businessRules": [],
    "sources": [],
}


@pytest.fixture()
def catalog() -> OntologyCatalog:
    return OntologyCatalog(
        version="v1",
        fingerprint=ontology_fingerprint(MINIMAL_BUNDLE),
        bundle=MINIMAL_BUNDLE,
    )


def _make_db(tmp_path: Path) -> Path:
    """Create a temp SQLite DB that matches the ontology above."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE defects (defect_id TEXT, severity TEXT, status TEXT)")
    conn.execute("CREATE TABLE teams (team_id TEXT, team_name TEXT)")
    conn.close()
    return db_path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_no_drift(catalog: OntologyCatalog, tmp_path: Path) -> None:
    """When DB schema matches ontology → empty report."""
    db_path = _make_db(tmp_path)
    detector = SchemaDriftDetector(catalog=catalog, db_path=db_path)
    report = detector.detect_drift()
    assert not report.has_drift
    assert report.total_entities_checked == 2
    assert report.drifts == []


def test_extra_column(catalog: OntologyCatalog, tmp_path: Path) -> None:
    """DB has column not in ontology → reported as unmapped."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE defects (defect_id TEXT, severity TEXT, status TEXT, priority TEXT)")
    conn.execute("CREATE TABLE teams (team_id TEXT, team_name TEXT)")
    conn.close()

    detector = SchemaDriftDetector(catalog=catalog, db_path=db_path)
    report = detector.detect_drift()
    assert report.has_drift
    unmapped = [d for d in report.drifts if d.drift_type == "unmapped"]
    assert len(unmapped) == 1
    assert unmapped[0].column_name == "priority"
    assert unmapped[0].entity_id == "quality.defect"
    assert unmapped[0].table == "defects"


def test_missing_column(catalog: OntologyCatalog, tmp_path: Path) -> None:
    """Ontology expects column not in DB → reported as missing."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    # defects table missing 'status' column
    conn.execute("CREATE TABLE defects (defect_id TEXT, severity TEXT)")
    conn.execute("CREATE TABLE teams (team_id TEXT, team_name TEXT)")
    conn.close()

    detector = SchemaDriftDetector(catalog=catalog, db_path=db_path)
    report = detector.detect_drift()
    missing = [d for d in report.drifts if d.drift_type == "missing"]
    assert len(missing) == 1
    assert missing[0].column_name == "status"
    assert missing[0].entity_id == "quality.defect"


def test_table_not_found(catalog: OntologyCatalog, tmp_path: Path) -> None:
    """Entity references non-existent table → reported."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    # Only create 'defects' table, not 'teams'
    conn.execute("CREATE TABLE defects (defect_id TEXT, severity TEXT, status TEXT)")
    conn.close()

    detector = SchemaDriftDetector(catalog=catalog, db_path=db_path)
    report = detector.detect_drift()
    assert report.has_drift
    # The missing table should produce at least one drift entry
    team_drifts = [d for d in report.drifts if d.entity_id == "organization.team"]
    assert len(team_drifts) >= 1
    assert team_drifts[0].table == "teams"


def test_suggest_mapping(catalog: OntologyCatalog, tmp_path: Path) -> None:
    """For unmapped column, suggest ontology property by name similarity."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    # 'defect_i' is close to 'defect_id'
    conn.execute("CREATE TABLE defects (defect_id TEXT, severity TEXT, status TEXT, defect_i TEXT)")
    conn.execute("CREATE TABLE teams (team_id TEXT, team_name TEXT)")
    conn.close()

    detector = SchemaDriftDetector(catalog=catalog, db_path=db_path)
    report = detector.detect_drift()
    suggestions = detector.suggest_mappings(report)
    assert len(suggestions) >= 1
    # The closest property to "defect_i" should be "defect_id"
    top = suggestions[0]
    assert top.suggested_property_id == "defect_id"
    assert top.confidence > 0.5


def test_drift_report_structure() -> None:
    """DriftReport has entity_id, table, unmapped_columns, missing_columns."""
    drifts = [
        ColumnDrift(entity_id="e1", table="t1", column_name="extra", drift_type="unmapped"),
        ColumnDrift(entity_id="e1", table="t1", column_name="gone", drift_type="missing"),
    ]
    report = DriftReport(total_entities_checked=1, drifts=drifts)

    # Verify structure via the per-entity grouping pattern
    assert report.total_entities_checked == 1
    assert report.has_drift

    # Group by entity to check structure
    entity_drifts = [d for d in report.drifts if d.entity_id == "e1"]
    unmapped_cols = [d.column_name for d in entity_drifts if d.drift_type == "unmapped"]
    missing_cols = [d.column_name for d in entity_drifts if d.drift_type == "missing"]
    assert unmapped_cols == ["extra"]
    assert missing_cols == ["gone"]
    assert all(d.table == "t1" for d in entity_drifts)
