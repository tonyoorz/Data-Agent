"""
OntologyAutoUpdate — automated discovery and proposal pipeline.

This module closes the loop between ontology usage and ontology maintenance:

    1. Collect query logs and DB schema state
    2. Detect schema drift (new/removed columns)
    3. Discover unresolved phrases (vocab gaps)
    4. Discover relationship candidates (co-occurring entities)
    5. Use LLM to propose new ontology elements
    6. Output a structured proposal for human review

The output is a JSON report that can be reviewed and applied via
the existing ontology enhancement workflow.

CLI usage::

    python -m backend.analytics.ontology_auto_update analyze \\
        --query-log-path /path/to/query_logs.json \\
        --output /path/to/discovery_report.json

    python -m backend.analytics.ontology_auto_update propose \\
        --report /path/to/discovery_report.json \\
        --output /path/to/proposals.json
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sqlite3
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology
from backend.analytics.ontology_drift import SchemaDriftDetector, DriftReport, MappingSuggestion
from backend.analytics.ontology_discovery import OntologyDiscovery, DiscoveryReport

logger = logging.getLogger(__name__)


# ─── Data structures ───────────────────────────────────────────────────────


@dataclass
class AutoUpdateReport:
    """Complete auto-discovery report combining drift + discovery + proposals."""

    generated_at: str = ""
    ontology_fingerprint: str = ""
    schema_drift: dict[str, Any] = field(default_factory=dict)
    vocab_gaps: list[dict] = field(default_factory=list)
    relationship_candidates: list[dict] = field(default_factory=list)
    llm_proposals: list[dict] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)


# ─── Pipeline ──────────────────────────────────────────────────────────────


class OntologyAutoUpdate:
    """Automated ontology gap detection and proposal generation.

    Parameters:
        catalog: Pre-loaded OntologyCatalog (or auto-load)
        db_path: Path to SQLite database for drift detection
        query_logs: List of {"query": str, "timestamp": str, "user": str}
    """

    def __init__(
        self,
        catalog: OntologyCatalog | None = None,
        db_path: Path | None = None,
        query_logs: list[dict] | None = None,
    ):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None

        self._db_path = db_path or get_full_picture_source_db_path()
        self._query_logs = query_logs or []
        self._bundle = self._catalog.bundle if self._catalog else {}

    # ── Public API ─────────────────────────────────────────────────────

    def analyze(self) -> AutoUpdateReport:
        """Run full analysis pipeline: drift + discovery.

        Returns:
            AutoUpdateReport with all findings
        """
        report = AutoUpdateReport(
            generated_at=datetime.now(timezone.utc).isoformat(),
            ontology_fingerprint=self._catalog.fingerprint if self._catalog else "",
        )

        # 1. Schema drift detection
        report.schema_drift = self._detect_schema_drift()

        # 2. Vocabulary gap discovery
        report.vocab_gaps = self._discover_vocab_gaps()

        # 3. Relationship candidates
        report.relationship_candidates = self._discover_relationship_candidates()

        # 4. Generate summary
        report.summary = {
            "drift_count": len(report.schema_drift.get("drifts", [])),
            "mapping_suggestions": len(report.schema_drift.get("mapping_suggestions", [])),
            "vocab_gaps": len(report.vocab_gaps),
            "relationship_candidates": len(report.relationship_candidates),
            "new_relationship_count": sum(
                1 for r in report.relationship_candidates if not r.get("existing_relationship")
            ),
            "query_logs_analyzed": len(self._query_logs),
        }

        return report

    def propose(self, report: AutoUpdateReport | None = None) -> list[dict]:
        """Generate ontology element proposals from analysis report.

        Uses heuristic rules (no external LLM call required) to draft:
        - New vocabulary terms for unresolved phrases
        - Property mappings for unmapped DB columns
        - Relationship entries for co-occurring entities

        Returns:
            List of proposal dicts ready for human review
        """
        if report is None:
            report = self.analyze()

        proposals: list[dict] = []

        # Propose new vocabulary terms from gaps
        for gap in report.vocab_gaps:
            if gap.get("frequency", 0) < 2:
                continue  # Skip one-off terms

            proposal = {
                "type": "vocabulary_term",
                "id": f"auto.vocab.{gap['phrase'].replace(' ', '_')}",
                "status": "proposal",
                "proposed_phrase": gap["phrase"],
                "frequency": gap["frequency"],
                "sample_queries": gap.get("sample_queries", []),
                "suggested_term": {
                    "id": f"auto.vocab.{gap['phrase'].replace(' ', '_')}",
                    "phrases": [gap["phrase"]],
                    "kind": "synonym",
                    "governance": {
                        "status": "draft",
                        "owner": "OntologyAutoUpdate",
                    },
                },
                "rationale": f"Phrase '{gap['phrase']}' appeared {gap['frequency']} times in query logs but has no ontology mapping.",
                "confidence": min(0.9, gap["frequency"] / 20),
            }
            proposals.append(proposal)

        # Propose property mappings for unmapped columns
        for suggestion in report.schema_drift.get("mapping_suggestions", []):
            if suggestion.get("confidence", 0) < 0.5:
                continue

            proposal = {
                "type": "property_mapping",
                "status": "proposal",
                "column_name": suggestion["column_name"],
                "suggested_property_id": suggestion["suggested_property_id"],
                "confidence": suggestion["confidence"],
                "rationale": f"DB column '{suggestion['column_name']}' is not mapped to any ontology property. Closest match: '{suggestion['suggested_property_id']}'.",
                "suggested_action": f"Add property '{suggestion['suggested_property_id']}' to the relevant entity, or confirm it as a new property.",
            }
            proposals.append(proposal)

        # Propose new relationships for high co-occurrence pairs
        for rel_candidate in report.relationship_candidates:
            if rel_candidate.get("existing_relationship"):
                continue
            if rel_candidate.get("co_occurrence_count", 0) < 3:
                continue

            proposal = {
                "type": "relationship",
                "status": "proposal",
                "entity_a": rel_candidate["entity_a"],
                "entity_b": rel_candidate["entity_b"],
                "co_occurrence_count": rel_candidate["co_occurrence_count"],
                "rationale": f"Entities '{rel_candidate['entity_a']}' and '{rel_candidate['entity_b']}' co-occur in {rel_candidate['co_occurrence_count']} queries but have no ontology relationship.",
                "suggested_relationship": {
                    "id": f"auto.rel.{rel_candidate['entity_a'].split('.')[-1]}.{rel_candidate['entity_b'].split('.')[-1]}",
                    "predicate": "related_to",
                    "sourceEntity": rel_candidate["entity_a"],
                    "targetEntity": rel_candidate["entity_b"],
                    "direction": "outbound",
                    "cardinality": "many_to_many",
                    "reversible": True,
                    "governance": {
                        "status": "draft",
                        "owner": "OntologyAutoUpdate",
                    },
                },
                "confidence": min(0.8, rel_candidate["co_occurrence_count"] / 15),
            }
            proposals.append(proposal)

        # Sort by confidence descending
        proposals.sort(key=lambda p: -p.get("confidence", 0))
        return proposals

    def generate_report(self) -> dict[str, Any]:
        """Run full pipeline and return a JSON-serializable report."""
        analysis = self.analyze()
        proposals = self.propose(analysis)

        report = asdict(analysis)
        report["llm_proposals"] = proposals
        report["summary"]["proposals_generated"] = len(proposals)

        # Categorize proposals
        proposal_types = Counter(p["type"] for p in proposals)
        report["summary"]["proposal_breakdown"] = dict(proposal_types)

        return report

    # ── Internal methods ───────────────────────────────────────────────

    def _detect_schema_drift(self) -> dict[str, Any]:
        """Detect ontology vs database schema drift."""
        if not self._catalog:
            return {"error": "no_ontology", "drifts": [], "mapping_suggestions": []}

        try:
            detector = SchemaDriftDetector(self._catalog, self._db_path)
            drift: DriftReport = detector.detect_drift()
            suggestions: list[MappingSuggestion] = detector.suggest_mappings(drift)

            return {
                "total_entities_checked": drift.total_entities_checked,
                "drift_count": len(drift.drifts),
                "drifts": [
                    {
                        "entity_id": d.entity_id,
                        "table": d.table,
                        "column_name": d.column_name,
                        "drift_type": d.drift_type,
                        "suggested_property": d.suggested_property,
                    }
                    for d in drift.drifts
                ],
                "mapping_suggestions": [
                    {
                        "column_name": s.column_name,
                        "suggested_property_id": s.suggested_property_id,
                        "confidence": s.confidence,
                    }
                    for s in suggestions
                ],
            }
        except Exception as exc:
            logger.warning("Schema drift detection failed: %s", exc)
            return {"error": str(exc), "drifts": [], "mapping_suggestions": []}

    def _discover_vocab_gaps(self) -> list[dict]:
        """Discover unresolved phrases in query logs."""
        if not self._catalog or not self._query_logs:
            return []

        try:
            discovery = OntologyDiscovery(self._catalog)
            report: DiscoveryReport = discovery.analyze_query_logs(self._query_logs)

            return [
                {
                    "phrase": tc.phrase,
                    "frequency": tc.frequency,
                    "sample_queries": tc.sample_queries,
                    "suggested_resolution": tc.suggested_resolution,
                }
                for tc in report.unresolved_phrases
                if tc.frequency >= 2  # Filter noise
            ]
        except Exception as exc:
            logger.warning("Vocab gap discovery failed: %s", exc)
            return []

    def _discover_relationship_candidates(self) -> list[dict]:
        """Discover potential new relationships from query co-occurrence."""
        if not self._catalog or not self._query_logs:
            return []

        try:
            discovery = OntologyDiscovery(self._catalog)
            candidates = discovery.suggest_new_relationships(self._query_logs)

            return [
                {
                    "entity_a": rc.entity_a,
                    "entity_b": rc.entity_b,
                    "co_occurrence_count": rc.co_occurrence_count,
                    "existing_relationship": rc.existing_relationship,
                }
                for rc in candidates
                if rc.co_occurrence_count >= 2
            ]
        except Exception as exc:
            logger.warning("Relationship discovery failed: %s", exc)
            return []


# ─── Query log collection ─────────────────────────────────────────────────


def collect_query_logs(db_path: Path | None = None, limit: int = 500) -> list[dict]:
    """Collect query logs from the agent's query history table.

    Looks for a query log table in the analytics database.
    Returns a list of {"query": str, "timestamp": str, "user": str}.
    """
    if db_path is None:
        db_path = get_full_picture_source_db_path()

    if not db_path.exists():
        return []

    try:
        conn = sqlite3.connect(str(db_path))
        # Check if query log table exists
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('agent_query_log', 'query_history', 'vizion_query_log')"
        )
        row = cursor.fetchone()
        if not row:
            conn.close()
            return []

        table = row[0]
        logs = conn.execute(
            f"SELECT query_text, created_at, user_id FROM {table} "
            f"ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()

        return [
            {"query": row[0] or "", "timestamp": row[1] or "", "user": row[2] or ""}
            for row in logs
        ]
    except Exception as exc:
        logger.warning("Query log collection failed: %s", exc)
        return []


# ─── CLI ───────────────────────────────────────────────────────────────────


def _cmd_analyze(args: argparse.Namespace) -> None:
    """CLI: analyze ontology gaps."""
    query_logs: list[dict] = []

    if args.query_log_path:
        with open(args.query_log_path, encoding="utf-8") as f:
            query_logs = json.load(f)
    elif args.collect_logs:
        query_logs = collect_query_logs(limit=args.log_limit)

    auto = OntologyAutoUpdate(query_logs=query_logs)
    report = auto.generate_report()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"✅ Report saved to {output_path}")
    print(f"   Drifts: {report['summary'].get('drift_count', 0)}")
    print(f"   Vocab gaps: {report['summary'].get('vocab_gaps', 0)}")
    print(f"   Relationship candidates: {report['summary'].get('relationship_candidates', 0)}")
    print(f"   Proposals: {report['summary'].get('proposals_generated', 0)}")


def _cmd_apply(args: argparse.Namespace) -> None:
    """CLI: review and apply proposals to ontology v1 files."""
    with open(args.report, encoding="utf-8") as f:
        report = json.load(f)

    proposals = report.get("llm_proposals", [])

    if not proposals:
        print("No proposals to apply.")
        return

    print(f"\n📋 {len(proposals)} proposals found:\n")

    for i, p in enumerate(proposals):
        ptype = p.get("type", "?")
        confidence = p.get("confidence", 0)
        rationale = p.get("rationale", "")
        print(f"  [{i+1}] ({ptype}, confidence={confidence:.2f})")
        print(f"      {rationale}")
        print()

    if not args.yes:
        response = input("Apply all proposals? [y/N]: ")
        if response.lower() not in ("y", "yes"):
            print("Cancelled.")
            return

    # Apply proposals to ontology v1 files
    _apply_proposals(proposals, args.ontology_root)
    print(f"✅ Applied {len(proposals)} proposals.")


def _apply_proposals(proposals: list[dict], ontology_root: str | None = None) -> None:
    """Apply proposals to ontology v1 JSON files."""
    base = Path(ontology_root) if ontology_root else Path(__file__).resolve().parents[2] / "ontology" / "v1"

    # Load existing files
    vocab_path = base / "vocab.zh-CN.json"
    rels_path = base / "relationships.json"

    # Apply vocabulary proposals
    vocab_data = json.loads(vocab_path.read_text(encoding="utf-8")) if vocab_path.exists() else {"schemaVersion": "1.0", "ontologyVersion": "v1", "terms": []}
    vocab_terms = vocab_data.get("terms", [])
    existing_ids = {t["id"] for t in vocab_terms}

    vocab_added = 0
    for p in proposals:
        if p.get("type") != "vocabulary_term":
            continue
        term = p.get("suggested_term", {})
        if term.get("id") not in existing_ids:
            vocab_terms.append(term)
            existing_ids.add(term.get("id", ""))
            vocab_added += 1

    vocab_data["terms"] = vocab_terms
    vocab_path.write_text(json.dumps(vocab_data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Apply relationship proposals
    rels_data = json.loads(rels_path.read_text(encoding="utf-8")) if rels_path.exists() else {"schemaVersion": "1.0", "ontologyVersion": "v1", "relationships": []}
    rels = rels_data.get("relationships", [])
    existing_rel_ids = {r["id"] for r in rels}

    rel_added = 0
    for p in proposals:
        if p.get("type") != "relationship":
            continue
        rel = p.get("suggested_relationship", {})
        if rel.get("id") not in existing_rel_ids:
            rels.append(rel)
            existing_rel_ids.add(rel.get("id", ""))
            rel_added += 1

    rels_data["relationships"] = rels
    rels_path.write_text(json.dumps(rels_data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"   vocab.zh-CN.json: +{vocab_added} terms")
    print(f"   relationships.json: +{rel_added} relationships")
    print("   ⚠️  Run ontology compile to generate new fingerprint!")


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Ontology Auto-Update: automated discovery and proposal pipeline"
    )
    subparsers = parser.add_subparsers(dest="command")

    # analyze
    p_analyze = subparsers.add_parser("analyze", help="Run analysis and generate report")
    p_analyze.add_argument("--query-log-path", help="Path to query logs JSON file")
    p_analyze.add_argument("--collect-logs", action="store_true", help="Collect logs from DB")
    p_analyze.add_argument("--log-limit", type=int, default=500, help="Max logs to collect")
    p_analyze.add_argument("--output", default="ontology/generated/auto_update_report.json")
    p_analyze.set_defaults(func=_cmd_analyze)

    # apply
    p_apply = subparsers.add_parser("apply", help="Apply proposals from a report")
    p_apply.add_argument("--report", required=True, help="Path to auto_update_report.json")
    p_apply.add_argument("--ontology-root", help="Path to ontology/v1 directory")
    p_apply.add_argument("--yes", "-y", action="store_true", help="Skip confirmation")
    p_apply.set_defaults(func=_cmd_apply)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    args.func(args)


if __name__ == "__main__":
    main()
