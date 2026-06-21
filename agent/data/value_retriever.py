"""Value Retriever — Dynamic database value lookup

Solves the "vocabulary gap": user says "车身控制器" but DB has "BCM".
Instead of relying on manual aliases, we:

1. Build a fuzzy index from actual DB distinct values at startup
2. Use rapidfuzz (Levenshtein-based) for fast candidate retrieval
3. Optionally use BGE embeddings for semantic matching
4. Inject matched values into SQL generation context

Two-tier matching:
- Tier 1 (fast): rapidfuzz token_set_ratio, threshold ≥ 70
- Tier 2 (semantic, optional): BGE cosine similarity, threshold ≥ 0.7

Usage:
    from agent.data.value_retriever import get_value_retriever

    vr = get_value_retriever(db_path="...")
    matches = vr.retrieve("车身控制器", field="assigned_ecu")
    # → [{"value": "BCM", "score": 92, "source": "fuzzy"}]

    # Auto-detect field from question
    matches = vr.retrieve("IDCEVO")  # → [{"value": "IDCEVO", "field": "project", ...}]

    # Inject into SQL generation
    hints = vr.get_hints_for_question("车身控制器有多少Critical缺陷")
    # → {"assigned_ecu": {"query": "车身控制器", "matches": ["BCM"]}}
"""

from __future__ import annotations

import os
import re
import sqlite3
import logging
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from pathlib import Path
from collections import defaultdict

logger = logging.getLogger(__name__)

# Try importing rapidfuzz (fast Levenshtein)
try:
    from rapidfuzz import fuzz, process as rf_process
    HAS_RAPIDFUZZ = True
except ImportError:
    HAS_RAPIDFUZZ = False
    logger.warning("rapidfuzz not installed, falling back to difflib")

    import difflib

    class _FuzzFallback:
        @staticmethod
        def token_set_ratio(s1, s2):
            return int(difflib.SequenceMatcher(None, s1.lower(), s2.lower()).ratio() * 100)

    class _ProcessFallback:
        @staticmethod
        def extract(query, choices, limit=5):
            results = []
            for choice in choices:
                score = _FuzzFallback.token_set_ratio(query, choice)
                results.append((choice, score, 0))
            results.sort(key=lambda x: x[1], reverse=True)
            return results[:limit]

    fuzz = _FuzzFallback()
    rf_process = _ProcessFallback()


# ============================================================================
# Data Structures
# ============================================================================

@dataclass
class ValueMatch:
    """A single value match result"""
    value: str              # Actual DB value
    field: str              # Which column
    score: float            # Match score (0-100)
    source: str             # "exact", "fuzzy", "semantic", "alias"
    original_query: str     # What the user typed


@dataclass
class FieldIndex:
    """Index for a single field's values"""
    field_name: str
    values: List[str]
    value_lower: List[str]  # Lowercase for case-insensitive matching
    aliases: Dict[str, str] = field(default_factory=dict)  # alias → canonical value

    def add_alias(self, alias: str, canonical: str):
        self.aliases[alias.lower()] = canonical


@dataclass
class RetrievalResult:
    """Result of a value retrieval request"""
    query: str
    matches: List[ValueMatch] = field(default_factory=list)
    field_detected: Optional[str] = None

    @property
    def best_match(self) -> Optional[ValueMatch]:
        return self.matches[0] if self.matches else None

    @property
    def values(self) -> List[str]:
        """Just the matched values"""
        return [m.value for m in self.matches]

    def to_sql_values(self) -> str:
        """Format as SQL IN clause values"""
        if not self.matches:
            return ""
        if len(self.matches) == 1:
            return f"'{self.matches[0].value}'"
        return ", ".join(f"'{m.value}'" for m in self.matches)


# ============================================================================
# Value Retriever
# ============================================================================

# Fields to index (high-cardinality, commonly filtered)
DEFAULT_INDEXED_FIELDS = [
    "project",
    "assigned_ecu",
    "severity",
    "status_phase",
    "domain",
    "top_aida",
    "problem_finder_team",
    "market",
    "phase",
    "solution_cluster",
    "detected_by",
]

# Minimum value length to index (skip very short values)
MIN_VALUE_LENGTH = 1

# Fuzzy match threshold (0-100, higher = stricter)
FUZZY_THRESHOLD = 65


class ValueRetriever:
    """
    Dynamic value retrieval from database.

    Builds an in-memory index of distinct values for key fields,
    then provides fuzzy + alias-based lookup.
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        table: str = "octane_defects",
        indexed_fields: Optional[List[str]] = None,
        ontology=None,
    ):
        self.db_path = db_path
        self.table = table
        self.indexed_fields = indexed_fields or DEFAULT_INDEXED_FIELDS
        self.ontology = ontology

        # Build index
        self._indexes: Dict[str, FieldIndex] = {}
        self._all_values: List[Tuple[str, str]] = []  # (value, field) for global search

        if db_path:
            self._build_index()

    def _build_index(self):
        """Build value indexes from database"""
        if not self.db_path:
            logger.warning("No DB path, ValueRetriever is empty")
            return

        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()

            for field_name in self.indexed_fields:
                try:
                    cursor.execute(
                        f"SELECT DISTINCT {field_name} FROM {self.table} "
                        f"WHERE {field_name} IS NOT NULL AND TRIM({field_name}) != ''"
                    )
                    values = [str(r[0]).strip() for r in cursor.fetchall()]
                    values = [v for v in values if len(v) >= MIN_VALUE_LENGTH]

                    if values:
                        idx = FieldIndex(
                            field_name=field_name,
                            values=values,
                            value_lower=[v.lower() for v in values],
                        )

                        # Load aliases from ontology if available
                        if self.ontology:
                            self._load_ontology_aliases(idx)

                        self._indexes[field_name] = idx

                        for v in values:
                            self._all_values.append((v, field_name))

                except sqlite3.OperationalError:
                    # Field doesn't exist in table
                    pass

            conn.close()

            total = sum(len(idx.values) for idx in self._indexes.values())
            logger.info(
                f"ValueRetriever indexed {total} values across "
                f"{len(self._indexes)} fields"
            )

        except Exception as e:
            logger.error(f"Failed to build value index: {e}")

    def _load_ontology_aliases(self, idx: FieldIndex):
        """Load aliases from ontology YAML for a field"""
        if not self.ontology:
            return

        prop = self.ontology.get_property("Defect", idx.field_name)
        if not prop or not prop.aliases:
            return

        # aliases format: {canonical_value: [alias1, alias2, ...]}
        for canonical, aliases in prop.aliases.items():
            for alias in aliases:
                idx.add_alias(alias, canonical)
            # Also add the canonical itself
            idx.add_alias(canonical, canonical)

    # ==================== Retrieval ====================

    def retrieve(
        self,
        query: str,
        field: Optional[str] = None,
        top_k: int = 3,
    ) -> RetrievalResult:
        """
        Retrieve matching values for a query string.

        Args:
            query: User's input (e.g., "车身控制器", "IDCEVO", "critical")
            field: Restrict search to a specific field (None = search all)
            top_k: Max results

        Returns:
            RetrievalResult with matches sorted by score
        """
        result = RetrievalResult(query=query, field_detected=field)
        query_lower = query.lower().strip()

        if not query_lower:
            return result

        fields_to_search = [field] if field and field in self._indexes else list(self._indexes.keys())

        for field_name in fields_to_search:
            idx = self._indexes[field_name]

            # Tier 0: Exact match (case-insensitive)
            for i, v_lower in enumerate(idx.value_lower):
                if v_lower == query_lower:
                    result.matches.append(ValueMatch(
                        value=idx.values[i],
                        field=field_name,
                        score=100.0,
                        source="exact",
                        original_query=query,
                    ))
                    break

            if result.matches and result.matches[-1].source == "exact":
                continue  # Exact match found for this field

            # Tier 1: Alias match
            if query_lower in idx.aliases:
                canonical = idx.aliases[query_lower]
                result.matches.append(ValueMatch(
                    value=canonical,
                    field=field_name,
                    score=95.0,
                    source="alias",
                    original_query=query,
                ))
                continue

            # Partial alias match (query contains alias or vice versa)
            for alias, canonical in idx.aliases.items():
                if len(alias) < 2:
                    continue
                if alias in query_lower or query_lower in alias:
                    score = 85 + (10 * min(len(query_lower), len(alias)) / max(len(query_lower), len(alias)))
                    result.matches.append(ValueMatch(
                        value=canonical,
                        field=field_name,
                        score=score,
                        source="alias_partial",
                        original_query=query,
                    ))
                    break

        # Tier 2: Fuzzy match (only if no exact/alias match)
        if not result.matches or all(m.score < 90 for m in result.matches):
            for field_name in fields_to_search:
                idx = self._indexes[field_name]

                # Use rapidfuzz for batch scoring
                fuzzy_results = rf_process.extract(
                    query_lower,
                    idx.value_lower,
                    scorer=fuzz.token_set_ratio,
                    limit=top_k,
                )

                for match_value, score, _ in fuzzy_results:
                    if score >= FUZZY_THRESHOLD:
                        # Find original (non-lowercase) value
                        orig_idx = idx.value_lower.index(match_value)
                        orig_value = idx.values[orig_idx]

                        # Avoid duplicates
                        already = any(
                            m.value == orig_value and m.field == field_name
                            for m in result.matches
                        )
                        if not already:
                            result.matches.append(ValueMatch(
                                value=orig_value,
                                field=field_name,
                                score=float(score),
                                source="fuzzy",
                                original_query=query,
                            ))

        # Sort by score and limit
        result.matches.sort(key=lambda m: m.score, reverse=True)
        result.matches = result.matches[:top_k]

        # Auto-detect field if not specified
        if not field and result.matches:
            result.field_detected = result.matches[0].field

        return result

    def retrieve_for_fields(
        self,
        query: str,
        top_k_per_field: int = 2,
    ) -> Dict[str, RetrievalResult]:
        """
        Retrieve matches for ALL indexed fields.

        Returns a dict: {field_name: RetrievalResult}
        Useful for building complete query context.
        """
        results = {}
        for field_name in self._indexes:
            r = self.retrieve(query, field=field_name, top_k=top_k_per_field)
            if r.matches:
                results[field_name] = r
        return results

    # ==================== Question-Level Helpers ====================

    # Field detection keywords
    FIELD_KEYWORDS = {
        "project": ["项目", "project", "车型", "平台"],
        "assigned_ecu": ["ECU", "控制器", "模块", "单元"],
        "severity": ["严重", "级别", "severity", "critical", "major", "minor"],
        "status_phase": ["状态", "status", "open", "closed", "fixed"],
        "domain": ["域", "领域", "domain"],
        "problem_finder_team": ["团队", "team", "测试组"],
        "market": ["市场", "market", "地区", "区域"],
        "top_aida": ["AIDA", "功能域"],
        "detected_by": ["测试人员", "发现者", "tester"],
        "phase": ["阶段", "phase"],
    }

    def get_hints_for_question(self, question: str) -> Dict[str, Any]:
        """
        Analyze a natural language question and return value hints for SQL generation.

        Returns:
            {
                "field_name": {
                    "query": "original_text",
                    "matches": ["DB_VALUE_1", "DB_VALUE_2"],
                    "best": "DB_VALUE_1",
                    "sql_in": "'DB_VALUE_1', 'DB_VALUE_2'"
                },
                ...
            }
        """
        hints = {}

        # Strategy 1: Try matching each known value against the question
        for field_name, idx in self._indexes.items():
            best_match = None
            best_score = 0

            for value in idx.values:
                if len(value) < 2:
                    continue
                # Check if value appears in question (case-insensitive)
                if value.lower() in question.lower():
                    score = len(value) * 10  # Longer matches are better
                    if score > best_score:
                        best_score = score
                        best_match = value

            # Also check aliases
            if not best_match:
                for alias, canonical in idx.aliases.items():
                    if len(alias) < 2:
                        continue
                    if alias.lower() in question.lower():
                        score = len(alias) * 10
                        if score > best_score:
                            best_score = score
                            best_match = canonical

            if best_match:
                hints[field_name] = {
                    "query": question,
                    "matches": [best_match],
                    "best": best_match,
                    "sql_in": f"'{best_match}'",
                }

        # Strategy 2: Extract unknown tokens and fuzzy-match them
        # Tokenize question
        tokens = self._extract_tokens(question)
        known_values = set()
        for idx in self._indexes.values():
            known_values.update(v.lower() for v in idx.values)

        for token in tokens:
            if token.lower() in known_values:
                continue  # Already matched
            if len(token) < 2:
                continue

            r = self.retrieve(token, top_k=1)
            if r.best_match and r.best_match.score >= 75 and r.best_match.field not in hints:
                field_name = r.best_match.field
                hints[field_name] = {
                    "query": token,
                    "matches": r.values,
                    "best": r.best_match.value,
                    "sql_in": r.to_sql_values(),
                }

        return hints

    def _extract_tokens(self, question: str) -> List[str]:
        """Extract meaningful tokens from question"""
        # Split on non-alphanumeric (keeps CJK chars)
        tokens = re.findall(r'[\w\u4e00-\u9fff]+', question)
        # Filter common stop words
        stop_words = {
            "的", "了", "在", "是", "有", "多少", "几个", "请", "问",
            "the", "a", "an", "how", "many", "what", "which", "show",
            "给我", "帮我", "查看", "查询", "统计",
        }
        return [t for t in tokens if t.lower() not in stop_words and len(t) >= 2]

    # ==================== SQL Enhancement ====================

    def enhance_sql_conditions(
        self,
        question: str,
        base_where: str = "1=1",
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Generate enhanced WHERE conditions using value retrieval.

        Returns:
            (enhanced_where_clause, hints_dict)
        """
        hints = self.get_hints_for_question(question)

        conditions = [base_where]
        for field_name, hint in hints.items():
            values = hint["matches"]
            if len(values) == 1:
                conditions.append(f"{field_name} = '{values[0]}'")
            elif len(values) > 1:
                in_clause = ", ".join(f"'{v}'" for v in values)
                conditions.append(f"{field_name} IN ({in_clause})")

        enhanced = " AND ".join(conditions)
        return enhanced, hints

    # ==================== Stats & Refresh ====================

    def stats(self) -> Dict[str, Any]:
        """Return index statistics"""
        return {
            "total_fields": len(self._indexes),
            "total_values": sum(len(idx.values) for idx in self._indexes.values()),
            "total_aliases": sum(len(idx.aliases) for idx in self._indexes.values()),
            "fields": {
                name: {
                    "values": len(idx.values),
                    "aliases": len(idx.aliases),
                }
                for name, idx in self._indexes.items()
            },
        }

    def refresh(self):
        """Rebuild index from database"""
        self._indexes.clear()
        self._all_values.clear()
        if self.db_path:
            self._build_index()


# ============================================================================
# Singleton
# ============================================================================

_retriever: Optional[ValueRetriever] = None


def get_value_retriever(
    db_path: Optional[str] = None,
    ontology=None,
) -> ValueRetriever:
    """Get or create singleton ValueRetriever"""
    global _retriever
    if _retriever is None:
        if db_path is None:
            from agent.data.adapter import resolve_data_db_path
            db_path = resolve_data_db_path()
        _retriever = ValueRetriever(db_path=db_path, ontology=ontology)
    return _retriever
