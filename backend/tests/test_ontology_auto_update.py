"""Tests for OntologyAutoUpdate — automated discovery and proposal pipeline.

Complete rewrite: rich mock catalog, proper query logs, real assertions
on proposal structure, confidence scoring, and filtering logic.
"""
from __future__ import annotations

import json
import pytest
from unittest.mock import MagicMock, patch
from pathlib import Path

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError
from backend.analytics.ontology_auto_update import (
    OntologyAutoUpdate,
    AutoUpdateReport,
    collect_query_logs,
)


# ─── Shared fixtures ───────────────────────────────────────────────────────


def _make_mock_catalog() -> OntologyCatalog:
    """Rich mock catalog matching the RAG/embedding test structure."""
    catalog = MagicMock(spec=OntologyCatalog)
    catalog.bundle = {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "entities": [
            {
                "id": "quality.defect",
                "labels": {"zh-CN": "缺陷"},
                "aliases": ["bug"],
                "governance": {"status": "approved"},
                "source": {"table": "octane_defects"},
                "properties": [{"id": "defect_id"}, {"id": "name"}, {"id": "phase"}],
            },
            {
                "id": "testing.test_run",
                "labels": {"zh-CN": "测试执行"},
                "aliases": ["MR"],
                "governance": {"status": "approved"},
                "source": {"table": "octane_manual_runs"},
                "properties": [{"id": "mr_id"}, {"id": "status"}],
            },
            {
                "id": "product.ecu",
                "labels": {"zh-CN": "ECU"},
                "aliases": ["模块"],
                "governance": {"status": "approved"},
                "source": {"table": "octane_defects"},
                "properties": [],
            },
        ],
        "relationships": [
            {
                "id": "rel.defect_detected_in",
                "predicate": "detected_in",
                "sourceEntity": "quality.defect",
                "targetEntity": "testing.test_run",
                "reversible": True,
                "governance": {"status": "approved"},
            },
        ],
        "metrics": [
            {
                "id": "defect.count",
                "labels": {"zh-CN": "缺陷数"},
                "entityId": "quality.defect",
                "governance": {"status": "approved"},
            },
        ],
        "terms": [
            {
                "id": "concept.top_issue",
                "phrases": ["Top Issue", "top issue"],
                "kind": "synonym",
                "resolution": {"metricId": "defect.count"},
                "governance": {"status": "approved"},
            },
            {
                "id": "entity.defect",
                "phrases": ["缺陷", "bug"],
                "kind": "synonym",
                "resolution": {"entityId": "quality.defect"},
                "governance": {"status": "approved"},
            },
        ],
        "constraints": [
            {
                "id": "rule1",
                "description": "Test rule",
                "enforcement": "plan",
                "parameters": {},
                "governance": {"status": "approved"},
            },
        ],
        "actions": [],
        "dimensions": [],
        "policies": [],
        "sources": [],
    }
    catalog.fingerprint = "test_fp_auto_001"
    return catalog


SAMPLE_QUERY_LOGS = [
    {"query": "show me Top Issue defects", "timestamp": "2026-01-01T10:00:00Z", "user": "tester1"},
    {"query": "有多少缺陷在ECU APP_Mobile_2_0", "timestamp": "2026-01-01T11:00:00Z", "user": "tester2"},
    {"query": "DTSV团队的通过率", "timestamp": "2026-01-01T12:00:00Z", "user": "tester1"},
    {"query": "flaky test统计", "timestamp": "2026-01-02T10:00:00Z", "user": "tester3"},
    {"query": "flaky test趋势分析", "timestamp": "2026-01-02T11:00:00Z", "user": "tester3"},
    {"query": "flaky test有哪些", "timestamp": "2026-01-02T14:00:00Z", "user": "tester1"},
    {"query": "show Top Issue data", "timestamp": "2026-01-02T15:00:00Z", "user": "tester1"},
    {"query": "regression test覆盖", "timestamp": "2026-01-03T09:00:00Z", "user": "tester2"},
    {"query": "regression test遗漏", "timestamp": "2026-01-03T10:00:00Z", "user": "tester4"},
]


# ─── Analyze tests ─────────────────────────────────────────────────────────


class TestOntologyAutoUpdateAnalyze:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.auto = OntologyAutoUpdate(
            catalog=self.catalog,
            db_path=Path("/nonexistent/db.db"),
            query_logs=SAMPLE_QUERY_LOGS,
        )

    def test_analyze_returns_report(self):
        report = self.auto.analyze()
        assert isinstance(report, AutoUpdateReport)
        assert report.ontology_fingerprint == "test_fp_auto_001"
        assert report.generated_at != ""

    def test_analyze_finds_vocab_gaps(self):
        """Unknown phrases ('flaky', 'regression') should appear in vocab gaps."""
        report = self.auto.analyze()
        gap_phrases = [g["phrase"] for g in report.vocab_gaps]
        assert "flaky" in gap_phrases

    def test_analyze_vocab_gap_has_structure(self):
        """Each vocab gap should have phrase, frequency, sample_queries."""
        report = self.auto.analyze()
        for gap in report.vocab_gaps:
            assert "phrase" in gap
            assert "frequency" in gap
            assert "sample_queries" in gap
            assert gap["frequency"] >= 2  # Filter noise

    def test_analyze_finds_regression_as_gap(self):
        """'regression test' appears twice → should be in gaps."""
        report = self.auto.analyze()
        gap_phrases = [g["phrase"] for g in report.vocab_gaps]
        # 'regression' appears in 2 queries
        assert "regression" in gap_phrases

    def test_analyze_summary_has_counts(self):
        report = self.auto.analyze()
        assert "drift_count" in report.summary
        assert "vocab_gaps" in report.summary
        assert "query_logs_analyzed" in report.summary
        assert report.summary["query_logs_analyzed"] == len(SAMPLE_QUERY_LOGS)

    def test_analyze_summary_counts_match(self):
        """Summary counts should match actual data lengths."""
        report = self.auto.analyze()
        assert report.summary["vocab_gaps"] == len(report.vocab_gaps)
        assert report.summary["relationship_candidates"] == len(report.relationship_candidates)


class TestOntologyAutoUpdateAnalyzeEdgeCases:
    def test_no_query_logs(self):
        catalog = _make_mock_catalog()
        auto = OntologyAutoUpdate(catalog=catalog, db_path=Path("/nonexistent/db.db"))
        report = auto.analyze()
        assert report.vocab_gaps == []
        assert report.relationship_candidates == []

    def test_no_catalog(self):
        with patch("backend.analytics.ontology_auto_update.load_ontology",
                   side_effect=OntologyLoadError("no ontology")):
            auto = OntologyAutoUpdate(catalog=None)
            report = auto.analyze()
            assert report.ontology_fingerprint == ""
            assert report.vocab_gaps == []

    def test_empty_query_logs(self):
        catalog = _make_mock_catalog()
        auto = OntologyAutoUpdate(catalog=catalog, db_path=Path("/nonexistent/db.db"), query_logs=[])
        report = auto.analyze()
        assert report.vocab_gaps == []


# ─── Propose tests ─────────────────────────────────────────────────────────


class TestOntologyAutoUpdatePropose:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.auto = OntologyAutoUpdate(
            catalog=self.catalog,
            db_path=Path("/nonexistent/db.db"),
            query_logs=SAMPLE_QUERY_LOGS,
        )

    def test_propose_returns_list(self):
        proposals = self.auto.propose()
        assert isinstance(proposals, list)

    def test_propose_generates_vocab_proposals(self):
        """'flaky' appears 3 times → should generate a vocab proposal."""
        proposals = self.auto.propose()
        vocab_proposals = [p for p in proposals if p["type"] == "vocabulary_term"]
        assert len(vocab_proposals) > 0
        assert any("flaky" in p["proposed_phrase"] for p in vocab_proposals)

    def test_propose_vocabulary_structure(self):
        proposals = self.auto.propose()
        for p in proposals:
            if p["type"] == "vocabulary_term":
                assert "id" in p
                assert "proposed_phrase" in p
                assert "frequency" in p
                assert "sample_queries" in p
                assert "suggested_term" in p
                assert "rationale" in p
                assert "confidence" in p
                # suggested_term should have proper structure
                st = p["suggested_term"]
                assert "id" in st
                assert "phrases" in st
                assert "kind" in st
                assert "governance" in st
                assert st["governance"]["status"] == "draft"
                break

    def test_propose_filters_low_frequency(self):
        """Phrases appearing only once should NOT generate proposals."""
        single_logs = [
            {"query": "unique_random_phrase_xyz", "timestamp": "", "user": ""},
        ]
        auto = OntologyAutoUpdate(catalog=self.catalog, db_path=Path("/nonexistent/db.db"), query_logs=single_logs)
        proposals = auto.propose()
        vocab = [p for p in proposals if p["type"] == "vocabulary_term"]
        assert len(vocab) == 0

    def test_propose_sorted_by_confidence(self):
        proposals = self.auto.propose()
        for i in range(len(proposals) - 1):
            assert proposals[i].get("confidence", 0) >= proposals[i + 1].get("confidence", 0)

    def test_propose_confidence_in_range(self):
        """All confidence values should be in [0, 1]."""
        proposals = self.auto.propose()
        for p in proposals:
            assert 0 <= p.get("confidence", 0) <= 1

    def test_propose_flaky_higher_confidence_than_regression(self):
        """'flaky' (3 occurrences) should have higher confidence than 'regression' (2)."""
        proposals = self.auto.propose()
        vocab = [p for p in proposals if p["type"] == "vocabulary_term"]
        flaky = [p for p in vocab if "flaky" in p["proposed_phrase"]]
        regression = [p for p in vocab if "regression" in p["proposed_phrase"]]
        if flaky and regression:
            assert flaky[0]["confidence"] >= regression[0]["confidence"]


# ─── Generate report tests ─────────────────────────────────────────────────


class TestOntologyAutoUpdateGenerateReport:
    def setup_method(self):
        self.catalog = _make_mock_catalog()
        self.auto = OntologyAutoUpdate(
            catalog=self.catalog,
            db_path=Path("/nonexistent/db.db"),
            query_logs=SAMPLE_QUERY_LOGS,
        )

    def test_generate_report_json_serializable(self):
        report = self.auto.generate_report()
        json_str = json.dumps(report, ensure_ascii=False)
        assert isinstance(json_str, str)
        parsed = json.loads(json_str)
        assert "summary" in parsed

    def test_generate_report_has_proposals(self):
        report = self.auto.generate_report()
        assert "llm_proposals" in report
        assert len(report["llm_proposals"]) > 0

    def test_generate_report_summary_has_proposal_count(self):
        report = self.auto.generate_report()
        assert "proposals_generated" in report["summary"]
        assert report["summary"]["proposals_generated"] == len(report["llm_proposals"])

    def test_generate_report_has_proposal_breakdown(self):
        report = self.auto.generate_report()
        assert "proposal_breakdown" in report["summary"]
        breakdown = report["summary"]["proposal_breakdown"]
        if report["llm_proposals"]:
            assert "vocabulary_term" in breakdown


# ─── Collect query logs tests ──────────────────────────────────────────────


class TestCollectQueryLogs:
    def test_nonexistent_db(self):
        logs = collect_query_logs(Path("/nonexistent/path/db.db"))
        assert logs == []

    def test_no_query_table(self, tmp_path):
        """DB without query log table returns empty."""
        import sqlite3
        db = tmp_path / "test.db"
        conn = sqlite3.connect(str(db))
        conn.execute("CREATE TABLE other_table (id INTEGER)")
        conn.close()
        logs = collect_query_logs(db)
        assert logs == []

    def test_collects_from_agent_query_log(self, tmp_path):
        """Should read from agent_query_log table if it exists."""
        import sqlite3
        db = tmp_path / "test.db"
        conn = sqlite3.connect(str(db))
        conn.execute("""
            CREATE TABLE agent_query_log (
                query_text TEXT,
                created_at TEXT,
                user_id TEXT
            )
        """)
        conn.execute(
            "INSERT INTO agent_query_log VALUES (?, ?, ?)",
            ("test query", "2026-01-01", "user1"),
        )
        conn.commit()
        conn.close()

        logs = collect_query_logs(db)
        assert len(logs) == 1
        assert logs[0]["query"] == "test query"
        assert logs[0]["user"] == "user1"

    def test_respects_limit(self, tmp_path):
        import sqlite3
        db = tmp_path / "test.db"
        conn = sqlite3.connect(str(db))
        conn.execute("""
            CREATE TABLE agent_query_log (
                query_text TEXT,
                created_at TEXT,
                user_id TEXT
            )
        """)
        for i in range(10):
            conn.execute(
                "INSERT INTO agent_query_log VALUES (?, ?, ?)",
                (f"query {i}", f"2026-01-{i:02d}", f"user{i}"),
            )
        conn.commit()
        conn.close()

        logs = collect_query_logs(db, limit=5)
        assert len(logs) == 5
